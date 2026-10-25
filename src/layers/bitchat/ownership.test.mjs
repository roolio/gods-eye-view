import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createBitchatLayer } from './index.js';
Cesium.ContextLimits._maximumAliasedLineWidth = 1;
import { layerFeedState } from '../../data/feedState.js';

function harness(getSnapshot) {
  const resources = [];
  const viewer = {
    camera: { positionCartographic: { height: 3000000 } },
    scene: {
      groundPrimitives: {
        add(value) {
          resources.push(value);
          return value;
        },
        remove(value) {
          resources.splice(resources.indexOf(value), 1);
          value.destroy();
        },
      },
    },
  };
  const layer = createBitchatLayer({
    source: {
      getSnapshot,
      getMessages: async () => ({ people: 0, messages: [] }),
    },
  });
  layer.init(viewer);
  return { layer, viewer, resources };
}
const snapshot = {
  status: 'live',
  relays: { listed: 377, open: 300 },
  cells: [{ geohash: 'u09', people: 10, messages: 5, lastAt: 1000 }],
  coarse: [{ geohash: 'u0', people: 20 }],
};

test('each instance owns batched rectangles, outlines and cleanup', async () => {
  const calls = [];
  const a = harness(async (query) => {
    calls.push(query);
    return snapshot;
  });
  const b = harness(async () => snapshot);
  assert.equal(await a.layer.update(), false);
  a.layer.enable();
  assert.equal(await a.layer.update(), true);
  assert.deepEqual(calls, [{ precision: 3 }]);
  const fill = a.resources[0].get(0);
  assert.equal(fill.geometryInstances.length, 1);
  assert.equal(fill.geometryInstances[0].id, 'bitchat:u09');
  assert.equal(
    fill.geometryInstances[0].geometry instanceof Cesium.RectangleGeometry,
    true,
  );
  assert.equal(a.resources[1].get(0).geometryInstances.length, 1);
  assert.equal(b.resources[0].length, 0);
  assert.equal(layerFeedState(a.layer.getStats()), 'nominal');
  a.layer.disable();
  assert.equal(a.resources[0].length, 0);
  assert.equal(a.resources[0].show, false);
  a.layer.destroy();
  b.layer.destroy();
  assert.equal(a.resources.length, 0);
  assert.equal(fill.isDestroyed(), true);
});

test('disable aborts acquisition and late data cannot repopulate the display', async () => {
  let resolve, signal;
  const h = harness((_query, options) => {
    signal = options.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  h.layer.enable();
  const request = h.layer.update();
  h.layer.disable();
  assert.equal(signal.aborted, true);
  resolve(snapshot);
  assert.equal(await request, false);
  assert.equal(h.resources[0].length, 0);
  h.layer.destroy();
});

test('warming and degraded coverage report through feed health and failure clears geometry', async () => {
  let status = 'warming';
  const h = harness(async () => {
    if (status === 'failure') throw new Error('offline');
    return { ...snapshot, status };
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'loading');
  status = 'degraded';
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  status = 'failure';
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
  assert.equal(h.resources[0].length, 0);
  h.layer.destroy();
});

test('ground selection respects contacts and tools, refreshes and closes with privacy or lifecycle changes', async () => {
  const picking = await import('../../data/pickRegistry.js');
  let click,
    picked = null,
    free = true;
  let nextSnapshot = snapshot;
  let data = {
    people: 12,
    messages: [{ text: '<img onerror=alert(1)>', at: 1800000000 }],
  };
  const entries = new Map(),
    visible = new Map();
  const h = harness(async () => snapshot);
  h.layer.destroy();
  h.viewer.camera.pickEllipsoid = () =>
    Cesium.Cartesian3.fromDegrees(2.1, 48.5);
  h.viewer.scene.pick = () => picked;
  const layer = createBitchatLayer({
    source: {
      getSnapshot: async () => nextSnapshot,
      getMessages: async () => data,
    },
    now: () => 1800000060000,
    picking,
    pointer: { isPointerFree: () => free },
    overlayHost: {
      setEntries(id, rows) {
        entries.set(id, rows);
      },
      setVisible(id, value) {
        visible.set(id, value);
      },
      clearSource(id) {
        entries.delete(id);
      },
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(action) {
        click = action;
      },
      destroy() {},
    }),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  layer.init(h.viewer);
  layer.enable();
  await layer.update();
  picking.registerPickOwner('test-contact', (id) => id === 'flight:123');
  picked = { id: 'flight:123' };
  click({ position: { x: 10, y: 10 } });
  await flush();
  assert.equal(entries.has('bitchat-card'), false);
  picked = null;
  free = false;
  click({ position: { x: 10, y: 10 } });
  await flush();
  assert.equal(entries.has('bitchat-card'), false);
  free = true;
  click({ position: { x: 10, y: 10 } });
  await flush();
  assert.equal(entries.get('bitchat-card')[0].title, 'BITCHAT · u09');
  assert.deepEqual(entries.get('bitchat-card')[0].details, [
    '12 people · 5 messages',
    '<img onerror=alert(1)> · 1 minute ago',
    'Public messages from Bitchat location channels, shown live and not stored.',
  ]);
  data = { people: 13, messages: [{ text: 'fresh', at: 1800000060 }] };
  await layer.update();
  assert.equal(
    entries.get('bitchat-card')[0].details[1],
    'fresh · this minute',
  );
  data = { people: 0, messages: [] };
  await layer.update();
  assert.equal(entries.has('bitchat-card'), false);
  data = { people: 12, messages: [] };
  click({ position: { x: 10, y: 10 } });
  await flush();
  assert.equal(entries.get('bitchat-card')[0].title, 'BITCHAT · u09');
  nextSnapshot = { ...snapshot, cells: [] };
  await layer.update();
  assert.equal(entries.has('bitchat-card'), false);
  nextSnapshot = snapshot;
  await layer.update();
  click({ position: { x: 10, y: 10 } });
  await flush();
  h.viewer.camera.pickEllipsoid = () => Cesium.Cartesian3.fromDegrees(-90, 0);
  click({ position: { x: 10, y: 10 } });
  assert.equal(entries.has('bitchat-card'), false);
  h.viewer.camera.pickEllipsoid = () =>
    Cesium.Cartesian3.fromDegrees(2.1, 48.5);
  click({ position: { x: 10, y: 10 } });
  await flush();
  assert.equal(entries.get('bitchat-card')[0].title, 'BITCHAT · u09');
  layer.disable();
  assert.equal(visible.get('bitchat-card'), false);
  assert.equal(entries.has('bitchat-card'), false);
  assert.equal(picking.findPickOwner('bitchat:u09'), null);
  layer.destroy();
  picking.unregisterPickOwner('test-contact');
});

test('cards cap message excerpts and keep public content as literal text', async () => {
  const { buildBitchatCard } = await import('./cards.js');
  const card = buildBitchatCard(
    snapshot.cells[0],
    {
      people: 12,
      messages: Array.from({ length: 8 }, () => ({
        text: 'x'.repeat(180),
        at: 1800000000,
      })),
    },
    1800000060000,
  );
  assert.equal(card.details.length, 7);
  assert.equal(card.details[1], `${'x'.repeat(139)}… · 1 minute ago`);
});

test('card counts use singular forms for one person or one message', async () => {
  const { buildBitchatCard } = await import('./cards.js');
  const card = buildBitchatCard(
    { ...snapshot.cells[0], messages: 1 },
    { people: 1, messages: [] },
    1800000060000,
  );
  assert.equal(card.details[0], '1 person · 1 message');
});
