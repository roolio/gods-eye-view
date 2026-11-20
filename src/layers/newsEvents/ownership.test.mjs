import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { createNewsEventsLayer, newsEventPixelSize } from './index.js';
import { buildNewsEventCard, shortPlaceName } from './cards.js';

/**
 * The layer on a viewer double bound to a fake renderer: a draw port that
 * keeps its sets, a camera whose eye the test moves, the frame's pre-render
 * listeners, the globe's visibility and the query port's terrain height.
 */
function harness(
  source,
  {
    cardHit = () => null,
    globeShown = false,
    terrainHeight = null,
    eye = null,
  } = {},
) {
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null, destroyed: 0 };
  const opened = [];
  const preRender = new Set();
  const heightQueries = [];
  const camera = { eye };
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera: {
      pose: () =>
        camera.eye
          ? { lon: 0, lat: 0, height: 8_000_000, position: { ...camera.eye } }
          : null,
    },
    frame: {
      requestRender() {},
      on(phase, listener) {
        assert.equal(phase, 'preRender');
        preRender.add(listener);
        return () => preRender.delete(listener);
      },
    },
    globe: { isGlobeVisible: () => globeShown },
    query: {
      sampleHeightNow(at, options) {
        heightQueries.push({ at, options });
        return terrainHeight;
      },
    },
  });
  // The card on top at a click, as the overlay host answers the registry.
  picking.setClickCardHitTest((x, y) => cardHit(x, y));
  const layer = createNewsEventsLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible = visible;
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
    },
    // The globe's clicks: one listener per click handler installed.
    input: () => ({
      onClick(callback) {
        clicks.handler = (pickId) =>
          callback({
            screenPosition: { x: 1, y: 2 },
            topHit: pickId
              ? { set: 'news-events:markers', id: pickId, surface: false }
              : null,
          });
        return () => {
          clicks.destroyed += 1;
          clicks.handler = null;
        };
      },
    }),
    picking,
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  layer.enable(viewer);
  const markerSet = () => draw.find('news-events:');
  return {
    layer,
    viewer,
    draw,
    overlay,
    clicks,
    opened,
    preRender,
    heightQueries,
    /** The set's items, in drawing order. */
    items: () => {
      const set = markerSet();
      return set && !set.disposed ? [...set.items.values()] : [];
    },
    markerSet,
    moveEye(lon, lat) {
      camera.eye = fromDegrees(lon, lat, 8_000_000);
      for (const listener of [...preRender]) listener();
    },
    dispose() {
      picking.setClickCardHitTest(null);
      unbind();
    },
  };
}

const row = {
  stableId: '-1456928',
  place: 'Paris, Ile-de-France, France',
  country: 'FR',
  lat: 48.8667,
  lon: 2.3333,
  articleCount: 4,
  mentions: 12,
  categories: { coercion: 1, protest: 3 },
  dominant: 'protest',
  latestMs: Date.UTC(2026, 9, 25, 8),
  events: [
    {
      category: 'protest',
      actor1: 'Police',
      actor2: 'Protester',
      mentions: 6,
      timeMs: Date.UTC(2026, 9, 25, 8),
      url: 'https://a.example/top',
      domain: 'a.example',
    },
    {
      category: 'coercion',
      actor1: null,
      actor2: null,
      mentions: 3,
      timeMs: Date.UTC(2026, 9, 25, 6),
      url: 'https://b.example/next',
      domain: 'b.example',
    },
  ],
};

test('each location renders as one point, the busiest drawn on top', async (t) => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: 'other', articleCount: 1 },
    ],
  });
  t.after(h.dispose);
  assert.equal(h.markerSet().kind, 'points');
  assert.equal(h.markerSet().show, true);
  assert.equal(await h.layer.update(h.viewer), true);
  const items = h.items();
  // Drawn (and picked) last means on top: a one-article neighbour must not
  // swallow the click meant for the busy place under it.
  assert.deepEqual(
    items.map(({ id }) => id),
    ['news-event:other', 'news-event:-1456928'],
  );
  assert.equal(items[1].pixelSize, newsEventPixelSize(4));
  assert.deepEqual(items[1].color, hexColor('#ffb300', 0.85));
  assert.deepEqual(items[1].outlineColor, [0, 0, 0, 0.6]);
  assert.equal(items[1].outlineWidth, 1);
  // Always on top: a marker hidden behind 3D tiles is a lost report.
  assert.equal(items[1].disableDepthTest, Number.POSITIVE_INFINITY);
  assert.ok(newsEventPixelSize(4) > newsEventPixelSize(1));
  assert.equal(newsEventPixelSize(1e6), 18);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getAnalystRecords()[0].protest, 3);
  assert.deepEqual(
    h.layer.getRowControls().legend.map(({ count }) => count),
    [0, 2],
  );
  h.layer.disable();
  assert.equal(h.markerSet().show, false);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy();
  assert.equal(h.markerSet(), undefined, 'the set is disposed');
});

test('markers sit at a fixed ground height instead of clamping to tiles', async (t) => {
  // Under photoreal tiles the globe is hidden: whatever a height query
  // answers there is not where the marker goes.
  const h = harness(
    { getSnapshot: async () => [row] },
    { globeShown: false, terrainHeight: -40_000 },
  );
  t.after(h.dispose);
  assert.equal(await h.layer.update(h.viewer), true);
  const [item] = h.items();
  // Clamping against hidden-globe photoreal tiles sank markers kilometres
  // under the surface, so they slid off their place on every zoom.
  assert.equal(item.height, undefined);
  const at = toLonLatH(item.pos);
  assert.ok(Math.abs(at.lat - row.lat) < 1e-9);
  assert.ok(Math.abs(at.lon - row.lon) < 1e-9);
  assert.ok(Math.abs(at.height) < 1e-3);
  assert.equal(h.heightQueries.length, 0);
});

test('with the globe drawn, markers take its terrain height', async (t) => {
  const h = harness(
    { getSnapshot: async () => [row] },
    { globeShown: true, terrainHeight: 35 },
  );
  t.after(h.dispose);
  assert.equal(await h.layer.update(h.viewer), true);
  const [item] = h.items();
  assert.equal(item.height, undefined);
  const at = toLonLatH(item.pos);
  assert.ok(Math.abs(at.height - 35) < 1e-3);
  assert.equal(h.heightQueries[0].options.against, 'terrain');
});

test('markers behind the horizon are hidden, and come back as the camera turns', async (t) => {
  const h = harness(
    {
      getSnapshot: async () => [
        row,
        { ...row, stableId: 'sydney', lat: -33.87, lon: 151.21 },
      ],
    },
    { eye: fromDegrees(2.35, 46, 8_000_000) },
  );
  t.after(h.dispose);
  assert.equal(await h.layer.update(h.viewer), true);
  const shown = () =>
    Object.fromEntries(h.items().map((item) => [item.id, item.show]));
  // Without the globe nothing hides the far side: Sydney would draw through
  // the planet over Europe and slide the wrong way on every zoom.
  assert.deepEqual(shown(), {
    'news-event:sydney': false,
    'news-event:-1456928': true,
  });
  h.moveEye(151.21, -33.87);
  assert.deepEqual(shown(), {
    'news-event:sydney': true,
    'news-event:-1456928': false,
  });
  h.layer.disable(h.viewer);
  assert.equal(h.preRender.size, 0);
});

test('late refresh cannot publish after disable or destroy', async (t) => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    t.after(h.dispose);
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.items().length, 0);
  }
});

test('a failed refresh reports the error and keeps the last good markers', async (t) => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('GDELT HTTP 502');
      return [row];
    },
  });
  t.after(h.dispose);
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().error, 'GDELT HTTP 502');
  assert.equal(h.items().length, 1);
});

test('clicking a marker opens its card; clicking the card opens the top article', async (t) => {
  let hit = null;
  const h = harness({ getSnapshot: async () => [row] }, { cardHit: () => hit });
  t.after(h.dispose);
  // A sibling layer that owns its own picks.
  picking.registerPickOwner('other-layer', (id) =>
    String(id).startsWith('other-layer:'),
  );
  t.after(() => picking.unregisterPickOwner('other-layer'));
  await h.layer.update(h.viewer);
  assert.equal(picking.findPickOwner('news-event:x'), 'news-events');
  assert.equal(picking.findPickOwner('flight:x'), null);

  h.clicks.handler('news-event:-1456928');
  const [card] = h.overlay.entries.get('news-events');
  assert.equal(card.title, 'NEWS · Paris, France');
  assert.equal(card.interactive, true);
  assert.equal(card.accent, '#ffb300');
  const at = toLonLatH(card.position);
  assert.ok(Math.abs(at.lat - row.lat) < 1e-9);

  hit = { sourceId: 'news-events', entryId: card.id };
  h.clicks.handler(null);
  assert.deepEqual(h.opened, ['https://a.example/top']);

  // Another layer's card on top is that layer's click: nothing changes.
  hit = { sourceId: 'other-layer', entryId: 'x' };
  h.clicks.handler('news-event:-1456928');
  assert.deepEqual(h.opened, ['https://a.example/top']);
  assert.equal(h.overlay.entries.get('news-events').length, 1);

  // A sibling layer's pick leaves the selection alone; empty space clears it.
  hit = null;
  h.clicks.handler('other-layer:1');
  assert.equal(h.overlay.entries.get('news-events').length, 1);
  h.clicks.handler(null);
  assert.equal(h.overlay.entries.get('news-events').length, 0);

  h.layer.disable(h.viewer);
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(picking.findPickOwner('news-event:x'), null);
});

test('the card states counts, the top reports and the caveat', () => {
  const card = buildNewsEventCard(row, Date.UTC(2026, 9, 25, 10), {
    link: null,
  });
  assert.deepEqual(card.details, [
    '4 articles in 24 h',
    'Coercion 1 · Protest 3',
    'Protest · Police → Protester · a.example · 2h ago',
    'Coercion · b.example · 4h ago',
    'Machine-coded media reports, not verified incidents',
  ]);
  assert.equal(card.interactive, false);
  assert.equal(
    shortPlaceName('Gaza, Israel (general), Israel'),
    'Gaza, Israel',
  );
  assert.equal(shortPlaceName('Azerbaijan'), 'Azerbaijan');
  assert.equal(shortPlaceName(''), null);
});
