import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStationLabelWinners } from './labels.js';
import { createTransitScene, STATION_SET_ID } from './scene.js';
import {
  collection,
  heightOf,
  lineFeature,
  LINES,
  parisFixture,
  parseNetwork,
  stationFeature,
  stubViewer,
} from './testFixtures.mjs';

function trackSummary(stub) {
  return stub
    .trackSets()
    .map((id) =>
      stub
        .trackItems(id)
        .map((item) => [item.widthPx, item.style.color, item.mode]),
    );
}

test('tracks: one draped set per casing level, deepest level made first', async () => {
  const stub = stubViewer();
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'terrain' },
  );
  assert.deepEqual(stub.trackSets(), [
    'transit-network:tracks:1',
    'transit-network:tracks:0',
  ]);
  assert.deepEqual(trackSummary(stub), [
    [[7.5, '#008B5B', 'draped']],
    [
      [4.5, '#5091CB', 'draped'],
      [4.5, '#008B5B', 'draped'],
      [3, '#FFBE00', 'draped'],
    ],
  ]);
  const sets = stub.trackSets().map((id) => stub.trackSet(id));
  assert.deepEqual(
    sets.map((set) => [set.spec.clampTo, set.spec.pickable]),
    [
      ['terrain', false],
      ['terrain', false],
    ],
  );
  scene.setSurface('tiles');
  assert.deepEqual(
    stub.trackSets().map((id) => stub.trackSet(id)),
    sets,
    'the same sets, draped anew',
  );
  assert.deepEqual(
    sets.map((set) => set.spec.clampTo),
    ['tiles', 'tiles'],
  );
  scene.dispose();
});

test('stations: one dot each, styled by its lines', async () => {
  const stub = stubViewer();
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'terrain' },
  );
  assert.equal(
    stub.renderer.testing.setRecord(STATION_SET_ID).spec.pickable,
    false,
  );
  assert.deepEqual(
    stub
      .dots()
      .map((dot) => [
        dot.id,
        dot.pixelSize,
        dot.color,
        dot.outlineColor,
        dot.show,
      ]),
    [
      ['gare:1', 8, '#FFFFFF', '#1A1A1A', true],
      ['gare:2', 8, '#FFFFFF', '#1A1A1A', true],
      ['gare:3', 6, '#FFFFFF', '#008B5B', true],
    ],
  );
  const chatelet = stub.dot('gare:1');
  assert.equal(chatelet.outlineWidth, 2);
  assert.deepEqual(chatelet.displayRange, [0, 60000]);
  assert.deepEqual(chatelet.scaleByDistance, {
    near: 1000,
    nearValue: 1,
    far: 40000,
    farValue: 0.5,
  });
  assert.equal(heightOf(chatelet.pos), 2, 'lifted 2 m off the ellipsoid');
  scene.dispose();
});

test('photoreal: a sampled height of 42 m anchors dot and label at 44 m', async () => {
  const stub = stubViewer({
    globeShow: false,
    heightM: 8000,
    surfaceHeight: () => 42,
  });
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'tiles' },
  );
  const chatelet = scene.records[0];
  assert.equal(stub.dot('gare:1').show, false);
  scene.sweep(stub.pose(), 0);
  assert.equal(stub.dot('gare:1').show, true);
  assert.equal(heightOf(chatelet.position), 44);
  assert.equal(heightOf(stub.dot('gare:1').pos), 44);
  assert.equal(chatelet.entry.position, chatelet.position);
  assert.equal(stub.sampleCalls[0].against, 'surface');
  assert.deepEqual(
    selectStationLabelWinners(scene.records, 3000).map((r) => r.station.name),
    ['Châtelet', 'Gare de Lyon', 'Gare du Nord'],
  );
  scene.dispose();
});

test('photoreal: no surface height keeps the dot hidden and offers no label', async () => {
  const stub = stubViewer({ globeShow: false, heightM: 8000 });
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'tiles' },
  );
  assert.deepEqual(scene.sweep(stub.pose(), 0), { pendingVisible: true });
  assert.deepEqual(
    stub.dots().map((dot) => dot.show),
    [false, false, false],
  );
  assert.deepEqual(selectStationLabelWinners(scene.records, 3000), []);
  assert.equal(stub.sampleCalls.length, 3);
  scene.sweep(stub.pose(), 999);
  assert.equal(stub.sampleCalls.length, 3, 'a miss waits 1 s before retrying');
  scene.sweep(stub.pose(), 1000);
  assert.equal(stub.sampleCalls.length, 6);
  assert.deepEqual(scene.stats(), {
    pendingHeights: 3,
    samplingUnsupported: false,
  });
  scene.dispose();
});

test('the globe: terrain answers first, the surface only on a terrain miss', async () => {
  const stub = stubViewer({
    terrainHeight: (point) => (point.lon === 2.347 ? 30 : null),
    surfaceHeight: () => 50,
  });
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'terrain' },
  );
  scene.sweep(stub.pose(), 0);
  assert.equal(heightOf(scene.records[0].position), 32);
  assert.equal(stub.sampleCalls.length, 0, 'Châtelet alone is in view');
  stub.lookDownFrom(2.347, 48.858, 8000);
  scene.sweep(stub.pose(), 0);
  assert.deepEqual(
    scene.records.map((r) => heightOf(r.position)),
    [32, 52, 52],
  );
  scene.dispose();
});

test('a stack switch forgets every sampled height before the next frame', async () => {
  let globeHeight = null;
  const stub = stubViewer({
    globeShow: false,
    surfaceHeight: () => 42,
    terrainHeight: () => globeHeight,
  });
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'tiles' },
  );
  scene.sweep(stub.pose(), 0);
  const chatelet = scene.records[0];
  assert.equal(heightOf(chatelet.position), 44);

  stub.renderer.globe.setGlobeVisible(true);
  globeHeight = 10;
  scene.setSurface('terrain');
  assert.equal(chatelet.resolved, false);
  assert.equal(
    stub.dot('gare:1').show,
    true,
    'globe dots stay visible while resolving',
  );
  scene.sweep(stub.pose(), 0);
  assert.equal(heightOf(chatelet.position), 12);
  assert.equal(heightOf(stub.dot('gare:1').pos), 12);

  stub.renderer.globe.setGlobeVisible(false);
  scene.setSurface('tiles');
  assert.equal(
    stub.dot('gare:1').show,
    false,
    'photoreal hides the stale globe anchor',
  );
  scene.dispose();
});

test('draping on both surfaces: the globe being hidden means photoreal', async () => {
  const stub = stubViewer({ globeShow: false });
  const network = await parseNetwork(parisFixture());
  const hidden = createTransitScene(stub.viewer, network, { clampTo: 'both' });
  assert.deepEqual(
    stub.dots().map((dot) => dot.show),
    [false, false, false],
  );
  hidden.dispose();
  stub.renderer.globe.setGlobeVisible(true);
  const shown = createTransitScene(stub.viewer, network, { clampTo: 'both' });
  assert.deepEqual(
    stub.dots().map((dot) => dot.show),
    [true, true, true],
  );
  shown.dispose();
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
  const stub = stubViewer({ globeShow: false });
  const scene = createTransitScene(stub.viewer, network, { clampTo: 'tiles' });
  scene.sweep(stub.pose(), 0);
  assert.equal(stub.sampleCalls.length, 24);
  assert.deepEqual(
    stub.sampleCalls.map((call) => Number(call.lon.toFixed(4))).slice(0, 3),
    [2.347, 2.3472, 2.3474],
  );
  scene.dispose();
});

test('a tile load re-arms nearby resolved stations for one resample', async () => {
  let height = 42;
  const stub = stubViewer({
    globeShow: false,
    heightM: 8000,
    surfaceHeight: () => height,
  });
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'tiles' },
  );
  scene.sweep(stub.pose(), 0);
  height = 50;
  assert.equal(scene.rearmNearby(), 3);
  scene.sweep(stub.pose(), 10);
  assert.equal(heightOf(scene.records[0].position), 52);
  assert.equal(heightOf(stub.dot('gare:1').pos), 52);
  scene.sweep(stub.pose(), 20);
  assert.equal(stub.sampleCalls.length, 6);
  scene.dispose();
});

test('photoreal without height sampling reports it and stops trying', async () => {
  const stub = stubViewer({ globeShow: false, sampleHeightSupported: false });
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'tiles' },
  );
  assert.deepEqual(scene.sweep(stub.pose(), 0), { pendingVisible: false });
  assert.deepEqual(scene.stats(), {
    pendingHeights: 3,
    samplingUnsupported: true,
  });
  scene.dispose();
});

test('dispose frees every draw set, twice and after the renderer is gone', async () => {
  const stub = stubViewer();
  const network = await parseNetwork(parisFixture());
  const scene = createTransitScene(stub.viewer, network, {
    clampTo: 'terrain',
  });
  assert.equal(stub.dots().length, 3);
  assert.equal(stub.trackSets().length, 2);
  scene.dispose();
  scene.dispose();
  assert.deepEqual(stub.renderer.testing.sets(), []);
  assert.equal(scene.records.length, 0);

  const second = createTransitScene(stub.viewer, network, {
    clampTo: 'terrain',
  });
  stub.renderer.destroy();
  stub.release();
  assert.doesNotThrow(() => second.dispose());
  assert.equal(second.records.length, 0);
});

test('dispose surfaces a draw set disposal error', async () => {
  const stub = stubViewer();
  const failure = new Error('draw set disposal failed');
  const points = stub.renderer.draw.points;
  stub.renderer.draw.points = (spec) => {
    const set = points(spec);
    const dispose = set.dispose.bind(set);
    set.dispose = () => {
      dispose();
      throw failure;
    };
    return set;
  };
  const scene = createTransitScene(
    stub.viewer,
    await parseNetwork(parisFixture()),
    { clampTo: 'terrain' },
  );
  assert.throws(
    () => scene.dispose(),
    (error) => error === failure,
  );
});
