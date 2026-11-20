import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitNetworkLayer } from './index.js';
import { STATION_SET_ID } from './scene.js';
import { createBundledTransitNetworkSource } from './source.js';
import {
  heightOf,
  parisFixture,
  parseNetwork,
  stubViewer,
} from './testFixtures.mjs';

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
  const stub = stubViewer({ terrainHeight: () => 0, ...viewerOptions });
  const { viewer } = stub;
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
  // [track sets, station sets] drawn now.
  const counts = () => [
    stub.trackSets().length,
    stub.renderer.testing.sets().filter((id) => id === STATION_SET_ID).length,
  ];
  return { layer, viewer, stub, host, source, stackEvents, counts };
}

test('two enables share one fetch, and the scene mounts when it lands', async () => {
  const { layer, viewer, source, counts } = setup();
  layer.enable(viewer);
  layer.enable(viewer);
  assert.equal(source.fetches, 1);
  assert.equal(layer.getStats().loading, true);
  assert.deepEqual(counts(), [0, 0]);
  await source.settle();
  assert.deepEqual(counts(), [2, 1]);
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

test('disable frees every draw set; re-enable mounts at once from the cache', async () => {
  const { layer, viewer, source, counts } = setup();
  layer.enable(viewer);
  await source.settle();
  layer.disable();
  assert.deepEqual(counts(), [0, 0]);
  layer.enable(viewer);
  assert.deepEqual(counts(), [2, 1]);
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

test('the tracks drape on what the scene shows when the layer starts', async () => {
  const { layer, viewer, stub, source } = setup({
    viewerOptions: { globeShow: false },
  });
  layer.enable(viewer);
  await source.settle();
  assert.deepEqual(
    stub.trackSets().map((id) => stub.trackSet(id).spec.clampTo),
    ['tiles', 'tiles'],
  );
  layer.destroy();
});

test('a map stack change drapes the mounted tracks anew in place', async () => {
  const { layer, viewer, stub, source, stackEvents } = setup();
  layer.enable(viewer);
  await source.settle();
  const sets = stub.trackSets().map((id) => stub.trackSet(id));
  assert.deepEqual(
    sets.map((set) => set.spec.clampTo),
    ['terrain', 'terrain'],
  );
  stackEvents.dispatchEvent(
    new CustomEvent('gev:map-stack-changed', {
      detail: { activeId: 'photoreal' },
    }),
  );
  assert.deepEqual(
    stub.trackSets().map((id) => stub.trackSet(id)),
    sets,
  );
  assert.deepEqual(
    sets.map((set) => set.spec.clampTo),
    ['tiles', 'tiles'],
  );
  layer.destroy();
});

test('station names show at 3 km, clear at 12.5 km, and leave with the layer', async () => {
  const { layer, viewer, stub, host, source } = setup();
  layer.enable(viewer);
  await source.settle();
  stub.renderer.testing.tick();
  stub.lookDownFrom(2.347, 48.858, 12_500);
  stub.renderer.testing.advance(600);
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

test('the surface finishing loading resamples the stations in view', async () => {
  let ground = 0;
  const { layer, viewer, stub, source } = setup({
    viewerOptions: { terrainHeight: () => ground },
  });
  stub.renderer.testing.setSettled('surface', false);
  layer.enable(viewer);
  await source.settle();
  const release = stub.renderer.frame.holdContinuous('loading');
  for (let frame = 0; frame < 20; frame++) stub.renderer.testing.tick();
  assert.equal(heightOf(stub.dot('gare:1').pos), 2);
  const before = stub.dot('gare:1').pos;
  ground = 20;
  for (let frame = 0; frame < 20; frame++) stub.renderer.testing.tick();
  assert.deepEqual(stub.dot('gare:1').pos, before, 'no resample while loading');
  stub.renderer.testing.setSettled('surface', true);
  for (let frame = 0; frame < 20; frame++) stub.renderer.testing.tick();
  release();
  assert.equal(heightOf(stub.dot('gare:1').pos), 22);
  assert.equal(layer.getStats().pendingHeights, 2, 'the two out of view');
  layer.destroy();
});

test('destroy removes every listener it added', async () => {
  const { layer, viewer, stub, source, stackEvents } = setup();
  layer.enable(viewer);
  await source.settle();
  assert.deepEqual(stub.listeners, { preRender: 1, moveEnd: 1 });
  layer.destroy();
  assert.deepEqual(stub.listeners, { preRender: 0, moveEnd: 0 });
  assert.doesNotThrow(() =>
    stackEvents.dispatchEvent(
      new CustomEvent('gev:map-stack-changed', { detail: { activeId: 'osm' } }),
    ),
  );
});

test('turning the camera without moving it refreshes the station cohort', async () => {
  const { layer, viewer, stub, host, source } = setup();
  layer.enable(viewer);
  await source.settle();
  stub.renderer.testing.tick();
  const { position, direction, up } = stub.pose();
  // Look along the old up (north) with the old view direction as down.
  stub.renderer.camera.setView({
    destination: position,
    orientation: {
      direction: up,
      up: { x: -direction.x, y: -direction.y, z: -direction.z },
    },
  });
  // Frames flow while the user turns the view.
  const release = stub.renderer.frame.holdContinuous('turning');
  for (let frame = 0; frame < 20; frame++) stub.renderer.testing.tick();
  release();
  assert.deepEqual(host.calls.slice(1), [
    ['entries', 'transit-network:stations', ['Châtelet']],
    ['entries', 'transit-network:stations', []],
  ]);
  layer.destroy();
});
