import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTransitNetworkLayer } from './index.js';
import { createBundledTransitNetworkSource } from './source.js';
import { fakeViewer, parisFixture, parseNetwork } from './testFixtures.mjs';

function deferredSource() {
  const pending = [];
  return {
    label: 'Île-de-France Mobilités',
    fetches: 0,
    signals: [],
    fetch(signal) {
      this.fetches++;
      this.signals.push(signal);
      return new Promise((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
    async settle() {
      const network = await parseNetwork(parisFixture());
      for (const { resolve } of pending.splice(0)) resolve(network);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function recordingHost() {
  const calls = [];
  return {
    calls,
    setVisible: (id, visible) => calls.push(['visible', id, visible]),
    setEntries: (id, entries) =>
      calls.push(['entries', id, entries.map((e) => e.title)]),
    clearSource: (id) => calls.push(['clear', id]),
  };
}

function setup({ source = deferredSource(), viewerOptions = {} } = {}) {
  const viewer = fakeViewer({ getHeight: () => 0, ...viewerOptions });
  const host = recordingHost();
  const stackEvents = new EventTarget();
  let time = 0;
  const layer = createTransitNetworkLayer({
    source,
    overlayHost: host,
    mapStackEventTarget: stackEvents,
    now: () => (time += 16),
  });
  layer.init(viewer);
  const counts = () => [
    viewer.scene.groundPrimitives.length,
    viewer.scene.primitives.length,
  ];
  return { layer, viewer, host, source, stackEvents, counts };
}

test('two enables share one fetch, and the scene mounts when it lands', async () => {
  const { layer, viewer, source, counts } = setup();
  layer.enable(viewer);
  layer.enable(viewer);
  assert.equal(source.fetches, 1);
  assert.equal(layer.getStats().loading, true);
  assert.deepEqual(counts(), [0, 0]);
  await source.settle();
  assert.deepEqual(counts(), [1, 1]);
  assert.deepEqual(layer.getStats(), {
    count: 3,
    lineCount: 3,
    stationCount: 3,
    lastUpdate: layer.getStats().lastUpdate,
    loading: false,
    loadingLabel: '',
    error: null,
    labelCount: 0,
    pendingHeights: 3,
    samplingUnsupported: false,
  });
  assert.equal(typeof layer.getStats().lastUpdate, 'number');
  layer.destroy();
});

test('disable before the fetch lands aborts it and mounts nothing', async () => {
  const { layer, viewer, source, counts } = setup();
  layer.enable(viewer);
  layer.disable();
  assert.equal(source.signals[0].aborted, true);
  await source.settle();
  assert.deepEqual(counts(), [0, 0]);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().loading, false);
  layer.destroy();
});

test('disable frees every primitive; re-enable mounts at once from the cache', async () => {
  const { layer, viewer, source, counts } = setup();
  layer.enable(viewer);
  await source.settle();
  layer.disable();
  assert.deepEqual(counts(), [0, 0]);
  layer.enable(viewer);
  assert.deepEqual(counts(), [1, 1]);
  assert.equal(source.fetches, 1);
  layer.destroy();
  assert.deepEqual(counts(), [0, 0]);
});

test('a malformed bundle surfaces in getStats().error', async () => {
  const source = createBundledTransitNetworkSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ type: 'Feature' }),
    }),
  });
  const { layer, viewer, counts } = setup({ source });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await layer.enable(viewer);
  } finally {
    console.warn = warn;
  }
  assert.equal(
    layer.getStats().error,
    'transit network: expected a FeatureCollection',
  );
  assert.deepEqual(counts(), [0, 0]);
  layer.destroy();
});

test('a map stack change reclassifies the mounted tracks in place', async () => {
  const { layer, viewer, source, stackEvents } = setup();
  layer.enable(viewer);
  await source.settle();
  const tracks = viewer.scene.groundPrimitives.get(0);
  const primitives = [tracks.get(0), tracks.get(1)];
  assert.deepEqual(
    primitives.map((p) => p.classificationType),
    [Cesium.ClassificationType.TERRAIN, Cesium.ClassificationType.TERRAIN],
  );
  stackEvents.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', {
      detail: { activeId: 'photoreal' },
    }),
  );
  assert.equal(viewer.scene.groundPrimitives.get(0).get(0), primitives[0]);
  assert.deepEqual(
    primitives.map((p) => p.classificationType),
    [
      Cesium.ClassificationType.CESIUM_3D_TILE,
      Cesium.ClassificationType.CESIUM_3D_TILE,
    ],
  );
  layer.destroy();
});

test('station names show at 3 km, clear at 12.5 km, and leave with the layer', async () => {
  const { layer, viewer, host, source } = setup();
  layer.enable(viewer);
  await source.settle();
  viewer.scene.preRender.raiseEvent();
  viewer.lookDownFrom(2.347, 48.858, 12_500);
  viewer.camera.moveEnd.raiseEvent();
  viewer.scene.preRender.raiseEvent();
  layer.disable();
  assert.deepEqual(host.calls, [
    ['visible', 'transit-network:stations', true],
    ['entries', 'transit-network:stations', ['Châtelet']],
    ['entries', 'transit-network:stations', []],
    ['clear', 'transit-network:stations'],
    ['visible', 'transit-network:stations', false],
  ]);
  layer.destroy();
});

test('destroy removes every listener it added', async () => {
  const { layer, viewer, source, stackEvents } = setup();
  layer.enable(viewer);
  await source.settle();
  assert.equal(viewer.scene.preRender.numberOfListeners, 1);
  assert.equal(viewer.camera.moveEnd.numberOfListeners, 1);
  layer.destroy();
  assert.equal(viewer.scene.preRender.numberOfListeners, 0);
  assert.equal(viewer.camera.moveEnd.numberOfListeners, 0);
  assert.doesNotThrow(() =>
    stackEvents.dispatchEvent(
      new CustomEvent('gev:map-stack-changed', { detail: { activeId: 'osm' } }),
    ),
  );
});

test('turning the camera without moving it refreshes the station cohort', async () => {
  const { layer, viewer, host, source } = setup();
  layer.enable(viewer);
  await source.settle();
  viewer.scene.preRender.raiseEvent();
  const { directionWC, upWC } = viewer.camera;
  const down = Cesium.Cartesian3.clone(directionWC);
  Cesium.Cartesian3.clone(upWC, directionWC);
  Cesium.Cartesian3.negate(down, upWC);
  for (let frame = 0; frame < 20; frame++) viewer.scene.preRender.raiseEvent();
  assert.deepEqual(host.calls.slice(1), [
    ['entries', 'transit-network:stations', ['Châtelet']],
    ['entries', 'transit-network:stations', []],
  ]);
  layer.destroy();
});
