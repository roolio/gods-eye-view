import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitchatLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { claimPointer, releasePointer } from '../../data/inputOwnership.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { fakeInputUnderLabel } from '../../input/testDoubles.mjs';
import { hslColor } from '../../render/color.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

/**
 * A viewer double with a fake draw port and camera bound, as the application
 * binds its renderer. Its scene's `pick` and camera's `pickEllipsoid` answer
 * a click's top hit and surface point.
 */
function scene() {
  const viewer = { camera: {}, scene: {} };
  const camera = fakeCameraPort({ pose: { height: 3000000 } });
  const { draw } = bindFakeDraw(viewer, { camera: camera.port });
  return { viewer, draw };
}

function harness(getSnapshot) {
  const { viewer, draw } = scene();
  const layer = createBitchatLayer({
    source: {
      getSnapshot,
      getMessages: async () => ({ people: 0, messages: [] }),
    },
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    draw,
    fills: draw.find('bitchat:'),
    outlines: draw.find('bitchat-coarse:'),
  };
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
  assert.notEqual(a.fills.spec.id, b.fills.spec.id);
  assert.equal(a.fills.kind, 'shapes');
  assert.equal(a.outlines.kind, 'lines');
  // Ground rectangles leave picks to the layers above them.
  assert.equal(a.fills.spec.pickable, false);
  assert.equal(a.outlines.spec.pickable, false);
  assert.equal(a.fills.spec.clampTo, 'both');
  assert.equal(a.fills.show, false);
  assert.equal(await a.layer.update(), false);
  a.layer.enable();
  assert.equal(a.fills.show, true);
  assert.equal(a.outlines.show, true);
  assert.equal(await a.layer.update(), true);
  assert.deepEqual(calls, [{ precision: 3 }]);
  assert.equal(a.fills.items.size, 1);
  const fill = a.fills.items.get('bitchat:u09');
  // The geohash cell's own bounds, draped on terrain and tiles.
  assert.deepEqual(fill.geometry, {
    kind: 'rectangle',
    rect: { west: 1.40625, south: 47.8125, east: 2.8125, north: 49.21875 },
  });
  assert.equal(fill.height, 'clampGround');
  assert.equal(fill.lit, false);
  // The only cell is the busiest: full intensity, red at 0.7 alpha.
  assert.deepEqual(fill.fill, hslColor(0, 0.9, 0.55, 0.7));
  assert.equal(a.outlines.items.size, 1);
  const outline = a.outlines.items.get('bitchat-coarse:u0');
  assert.equal(outline.mode, 'draped');
  assert.equal(outline.widthPx, 1);
  assert.deepEqual(outline.style, { kind: 'solid', color: [1, 1, 1, 0.25] });
  assert.equal(outline.positions.length, 5);
  assert.deepEqual(outline.positions[0], outline.positions[4]);
  assert.equal(b.fills.items.size, 0);
  assert.equal(layerFeedState(a.layer.getStats()), 'nominal');
  a.layer.disable();
  assert.equal(a.fills.items.size, 0);
  assert.equal(a.outlines.items.size, 0);
  assert.equal(a.fills.show, false);
  a.layer.destroy();
  b.layer.destroy();
  assert.equal(a.fills.disposed, true);
  assert.equal(a.outlines.disposed, true);
  assert.equal(b.fills.disposed, true);
  assert.equal(b.outlines.disposed, true);
});

test('colour and alpha follow log activity relative to the busiest cell', async () => {
  const h = harness(async () => ({
    ...snapshot,
    cells: [
      { geohash: 'u09', people: 3, messages: 1, lastAt: 1000 },
      { geohash: 'u0d', people: 15, messages: 9, lastAt: 1000 },
    ],
  }));
  h.layer.enable();
  await h.layer.update();
  const intensity = Math.log1p(3) / Math.log1p(15);
  assert.deepEqual(
    h.fills.items.get('bitchat:u09').fill,
    hslColor(0.45 - 0.45 * intensity, 0.9, 0.55, 0.3 + 0.4 * intensity),
  );
  assert.deepEqual(
    h.fills.items.get('bitchat:u0d').fill,
    hslColor(0, 0.9, 0.55, 0.7),
  );
  h.layer.destroy();
});

test('a scene with no renderer cannot draw the layer', () => {
  const layer = createBitchatLayer({
    source: {
      getSnapshot: async () => snapshot,
      getMessages: async () => ({ people: 0, messages: [] }),
    },
  });
  assert.throws(() => layer.init({}), /no renderer to draw with/);
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
  assert.equal(h.fills.items.size, 0);
  assert.equal(h.outlines.items.size, 0);
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
  assert.equal(h.fills.items.size, 1);
  status = 'failure';
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
  assert.equal(h.fills.items.size, 0);
  assert.equal(h.outlines.items.size, 0);
  h.layer.destroy();
});

test('ground selection respects contacts, tools and painted labels, refreshes and closes with privacy or lifecycle changes', async () => {
  const picking = await import('../../data/pickRegistry.js');
  let picked = null;
  let ground = fromDegrees(2.1, 48.5);
  let nextSnapshot = snapshot;
  let data = {
    people: 12,
    messages: [{ text: '<img onerror=alert(1)>', at: 1800000000 }],
  };
  const entries = new Map(),
    visible = new Map();
  const { viewer } = scene();
  viewer.scene.pick = () => picked;
  viewer.camera.pickEllipsoid = () => ground;
  const input = fakeInputUnderLabel(viewer);
  const layer = createBitchatLayer({
    source: {
      getSnapshot: async () => nextSnapshot,
      getMessages: async () => data,
    },
    now: () => 1800000060000,
    picking,
    inputFor: () => input.input,
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
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const click = () => input.click({ x: 10, y: 10 });
  // The painted label's own overlay handler is already subscribed.
  const baseline = input.input.subscriberCount();
  layer.init(viewer);
  assert.equal(input.input.subscriberCount(), baseline);
  layer.enable();
  assert.equal(input.input.subscriberCount(), baseline + 1);
  await layer.update();
  // A contact another layer owns takes the click.
  picking.registerPickOwner('test-contact', (id) => id === 'flight:123');
  picked = { id: 'flight:123' };
  click();
  await flush();
  assert.equal(entries.has('bitchat-card'), false);
  picked = null;
  // A tool holding the pointer keeps ambient selection off.
  const lease = claimPointer('test-tool');
  click();
  await flush();
  assert.equal(entries.has('bitchat-card'), false);
  releasePointer(lease);
  // A label painted over the map takes the click.
  input.label.over = true;
  click();
  await flush();
  assert.equal(entries.has('bitchat-card'), false);
  input.label.over = false;
  click();
  await flush();
  const [card] = entries.get('bitchat-card');
  assert.equal(card.title, 'BITCHAT · u09');
  assert.deepEqual(card.details, [
    '12 people · 5 messages',
    '<img onerror=alert(1)> · 1 minute ago',
    'Public messages from Bitchat location channels, shown live and not stored.',
  ]);
  // The card sits at the cell's centre.
  assert.deepEqual(card.position, fromDegrees(2.109375, 48.515625));
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
  click();
  await flush();
  assert.equal(entries.get('bitchat-card')[0].title, 'BITCHAT · u09');
  nextSnapshot = { ...snapshot, cells: [] };
  await layer.update();
  assert.equal(entries.has('bitchat-card'), false);
  nextSnapshot = snapshot;
  await layer.update();
  click();
  await flush();
  // A click outside every cell closes the card.
  ground = fromDegrees(-90, 0);
  click();
  assert.equal(entries.has('bitchat-card'), false);
  ground = fromDegrees(2.1, 48.5);
  click();
  await flush();
  assert.equal(entries.get('bitchat-card')[0].title, 'BITCHAT · u09');
  layer.disable();
  assert.equal(input.input.subscriberCount(), baseline);
  assert.equal(visible.get('bitchat-card'), false);
  assert.equal(entries.has('bitchat-card'), false);
  // Bitchat never claims picks of its own.
  assert.equal(picking.findPickOwner('bitchat:u09'), null);
  // Disabled, clicks do nothing.
  click();
  await flush();
  assert.equal(entries.has('bitchat-card'), false);
  layer.destroy();
  picking.unregisterPickOwner('test-contact');
  input.destroy();
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
