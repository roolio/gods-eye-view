import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { selectStationLabelWinners } from './labels.js';
import { createTransitScene } from './scene.js';
import {
  collection,
  fakeViewer,
  heightOf,
  lineFeature,
  LINES,
  parisFixture,
  parseNetwork,
  stationFeature,
} from './testFixtures.mjs';

const { CESIUM_3D_TILE, TERRAIN } = Cesium.ClassificationType;

function trackSummary(viewer) {
  const tracks = viewer.scene.groundPrimitives.get(0);
  return Array.from({ length: tracks.length }, (_, i) =>
    tracks
      .get(i)
      .geometryInstances.map((instance) => [
        instance.geometry.width,
        Cesium.Color.fromBytes(
          ...instance.attributes.color.value,
        ).toCssHexString(),
      ]),
  );
}

test('tracks: one primitive per casing level, deepest level added first', async () => {
  const viewer = fakeViewer();
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: TERRAIN,
  });
  assert.equal(viewer.scene.groundPrimitives.length, 1);
  assert.deepEqual(trackSummary(viewer), [
    [[7.5, '#008b5b']],
    [
      [4.5, '#5091cb'],
      [4.5, '#008b5b'],
      [3, '#ffbe00'],
    ],
  ]);
  const tracks = viewer.scene.groundPrimitives.get(0);
  const primitives = [tracks.get(0), tracks.get(1)];
  scene.setSurface(CESIUM_3D_TILE);
  assert.equal(tracks.get(0), primitives[0]);
  assert.deepEqual(
    primitives.map((primitive) => primitive.classificationType),
    [CESIUM_3D_TILE, CESIUM_3D_TILE],
  );
  scene.dispose();
});

test('photoreal: a sampled height of 42 m anchors dot and label at 44 m', async () => {
  const viewer = fakeViewer({
    globeShow: false,
    heightM: 8000,
    sampleHeight: () => 42,
  });
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: CESIUM_3D_TILE,
  });
  const chatelet = scene.records[0];
  assert.equal(chatelet.point.show, false);
  scene.sweep(viewer.camera, 0);
  assert.equal(chatelet.point.show, true);
  assert.equal(heightOf(chatelet.position), 44);
  assert.equal(heightOf(chatelet.point.position), 44);
  assert.equal(chatelet.entry.position, chatelet.position);
  assert.deepEqual(viewer.sampleCalls[0].exclude, [chatelet.point.id]);
  assert.deepEqual(
    selectStationLabelWinners(scene.records, 3000).map((r) => r.station.name),
    ['Châtelet', 'Gare de Lyon', 'Gare du Nord'],
  );
  scene.dispose();
});

test('photoreal: no surface height keeps the dot hidden and offers no label', async () => {
  const viewer = fakeViewer({ globeShow: false, heightM: 8000 });
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: CESIUM_3D_TILE,
  });
  assert.deepEqual(scene.sweep(viewer.camera, 0), { pendingVisible: true });
  assert.deepEqual(
    scene.records.map((r) => r.point.show),
    [false, false, false],
  );
  assert.deepEqual(selectStationLabelWinners(scene.records, 3000), []);
  assert.equal(viewer.sampleCalls.length, 3);
  scene.sweep(viewer.camera, 999);
  assert.equal(
    viewer.sampleCalls.length,
    3,
    'a miss waits 1 s before retrying',
  );
  scene.sweep(viewer.camera, 1000);
  assert.equal(viewer.sampleCalls.length, 6);
  assert.deepEqual(scene.stats(), {
    pendingHeights: 3,
    samplingUnsupported: false,
  });
  scene.dispose();
});

test('a stack switch forgets every sampled height before the next frame', async () => {
  let globeHeight;
  const viewer = fakeViewer({
    globeShow: false,
    sampleHeight: () => 42,
    getHeight: () => globeHeight,
  });
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: CESIUM_3D_TILE,
  });
  scene.sweep(viewer.camera, 0);
  const chatelet = scene.records[0];
  assert.equal(heightOf(chatelet.position), 44);

  viewer.scene.globe.show = true;
  globeHeight = 10;
  scene.setSurface(TERRAIN);
  assert.equal(chatelet.resolved, false);
  assert.equal(
    chatelet.point.show,
    true,
    'globe dots stay visible while resolving',
  );
  scene.sweep(viewer.camera, 0);
  assert.equal(heightOf(chatelet.position), 12);

  viewer.scene.globe.show = false;
  scene.setSurface(CESIUM_3D_TILE);
  assert.equal(
    chatelet.point.show,
    false,
    'photoreal hides the stale globe anchor',
  );
  scene.dispose();
});

test('100 pending stations: the first sweep samples only the 24 nearest', async () => {
  const stations = Array.from({ length: 100 }, (_, i) =>
    stationFeature(
      `gare:${i}`,
      `Gare ${i}`,
      ['C01371'],
      [2.347 + i * 0.0002, 48.858],
    ),
  );
  const network = await parseNetwork(
    collection([
      lineFeature(LINES.M1, 0, [
        [
          [2.33, 48.86],
          [2.36, 48.855],
        ],
      ]),
      ...stations.reverse(),
    ]),
  );
  const viewer = fakeViewer({ globeShow: false });
  const scene = createTransitScene(viewer, network, {
    classificationType: CESIUM_3D_TILE,
  });
  scene.sweep(viewer.camera, 0);
  assert.equal(viewer.sampleCalls.length, 24);
  assert.deepEqual(
    viewer.sampleCalls.map((call) => Number(call.lon.toFixed(4))).slice(0, 3),
    [2.347, 2.3472, 2.3474],
  );
  scene.dispose();
});

test('a tile load re-arms nearby resolved stations for one resample', async () => {
  let height = 42;
  const viewer = fakeViewer({
    globeShow: false,
    heightM: 8000,
    sampleHeight: () => height,
  });
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: CESIUM_3D_TILE,
  });
  scene.sweep(viewer.camera, 0);
  height = 50;
  assert.equal(scene.rearmNearby(), 3);
  scene.sweep(viewer.camera, 10);
  assert.equal(heightOf(scene.records[0].position), 52);
  scene.sweep(viewer.camera, 20);
  assert.equal(viewer.sampleCalls.length, 6);
  scene.dispose();
});

test('photoreal without height sampling reports it and stops trying', async () => {
  const viewer = fakeViewer({ globeShow: false, sampleHeightSupported: false });
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: CESIUM_3D_TILE,
  });
  assert.deepEqual(scene.sweep(viewer.camera, 0), { pendingVisible: false });
  assert.deepEqual(scene.stats(), {
    pendingHeights: 3,
    samplingUnsupported: true,
  });
  scene.dispose();
});

test('dispose frees every primitive, twice and after the viewer is gone', async () => {
  const viewer = fakeViewer();
  const network = await parseNetwork(parisFixture());
  const scene = createTransitScene(viewer, network, {
    classificationType: TERRAIN,
  });
  const tracks = viewer.scene.groundPrimitives.get(0);
  const points = viewer.scene.primitives.get(0);
  assert.equal(points.length, 3);
  scene.dispose();
  scene.dispose();
  assert.equal(viewer.scene.groundPrimitives.length, 0);
  assert.equal(viewer.scene.primitives.length, 0);
  assert.equal(tracks.isDestroyed(), true);
  assert.equal(points.isDestroyed(), true);

  const second = createTransitScene(viewer, network, {
    classificationType: TERRAIN,
  });
  viewer.scene.groundPrimitives.destroy();
  viewer.scene.primitives.destroy();
  assert.doesNotThrow(() => second.dispose());
});

test('dispose surfaces primitive removal errors while the viewer is alive', async () => {
  const viewer = fakeViewer();
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: TERRAIN,
  });
  const failure = new Error('primitive removal failed');
  const groundPrimitives = viewer.scene.groundPrimitives;
  const remove = groundPrimitives.remove;
  groundPrimitives.remove = () => {
    throw failure;
  };
  try {
    assert.throws(
      () => scene.dispose(),
      (error) => error === failure,
    );
  } finally {
    groundPrimitives.remove = remove;
    groundPrimitives.destroy();
    viewer.scene.primitives.destroy();
  }
});

test('dispose skips primitive removal when the viewer is destroyed', async () => {
  const viewer = fakeViewer();
  const scene = createTransitScene(viewer, await parseNetwork(parisFixture()), {
    classificationType: TERRAIN,
  });
  viewer.isDestroyed = () => true;
  viewer.scene.groundPrimitives.destroy();
  viewer.scene.primitives.destroy();
  viewer.scene.groundPrimitives.remove = () => {
    assert.fail('destroyed viewer primitives must not be removed');
  };
  assert.doesNotThrow(() => scene.dispose());
  assert.equal(scene.records.length, 0);
});
