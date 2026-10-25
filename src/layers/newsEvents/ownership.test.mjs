import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createNewsEventsLayer, newsEventPixelSize } from './index.js';
import { buildNewsEventCard, shortPlaceName } from './cards.js';

function harness(source, { pick = () => null, cardHit = () => null } = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const opened = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
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
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, overlay, clicks, owners, opened };
}

const row = {
  stableId: '-1456928',
  place: 'Paris, Ile-de-France, France',
  country: 'FR',
  lat: 48.8667,
  lon: 2.3333,
  articleCount: 4,
  mentions: 12,
  categories: { violence: 1, protest: 3, coercion: 0, tension: 0 },
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
      category: 'violence',
      actor1: null,
      actor2: null,
      mentions: 3,
      timeMs: Date.UTC(2026, 9, 25, 6),
      url: 'https://b.example/next',
      domain: 'b.example',
    },
  ],
};

test('each location renders as one point, the busiest drawn on top', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: 'other', articleCount: 1 },
    ],
  });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  // Drawn (and picked) last means on top: a one-article neighbour must not
  // swallow the click meant for the busy place under it.
  assert.deepEqual(
    entities.map(({ id }) => id),
    ['news-event:other', 'news-event:-1456928'],
  );
  assert.equal(entities[1].point.pixelSize.getValue(), newsEventPixelSize(4));
  assert.ok(newsEventPixelSize(4) > newsEventPixelSize(1));
  assert.equal(newsEventPixelSize(1e6), 18);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getAnalystRecords()[0].protest, 3);
  assert.deepEqual(
    h.layer.getRowControls().legend.map(({ count }) => count),
    [0, 2, 0, 0],
  );
});

test('markers sit at a fixed ground height instead of clamping to tiles', async () => {
  const h = harness({ getSnapshot: async () => [row] });
  assert.equal(await h.layer.update(h.viewer), true);
  const [entity] = h.sources[0].entities.values;
  // Clamping against hidden-globe photoreal tiles sank markers kilometres
  // under the surface, so they slid off their place on every zoom.
  assert.equal(entity.point.heightReference, undefined);
  const at = Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  );
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.latitude) - row.lat) < 1e-9);
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.longitude) - row.lon) < 1e-9);
  assert.ok(Math.abs(at.height) < 1e-3);
});

test('with the globe drawn, markers take its terrain height', async () => {
  const h = harness({ getSnapshot: async () => [row] });
  h.viewer.scene.globe = { show: true, getHeight: () => 35 };
  assert.equal(await h.layer.update(h.viewer), true);
  const [entity] = h.sources[0].entities.values;
  const at = Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  );
  assert.ok(Math.abs(at.height - 35) < 1e-3);
});

test('late refresh cannot publish after disable or destroy', async () => {
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
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
  }
});

test('a failed refresh reports the error and keeps the last good markers', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('GDELT HTTP 502');
      return [row];
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().error, 'GDELT HTTP 502');
  assert.equal(h.sources[0].entities.values.length, 1);
});

test('clicking a marker opens its card; clicking the card opens the top article', async () => {
  let picked = null;
  let hit = null;
  const h = harness(
    { getSnapshot: async () => [row] },
    { pick: () => picked, cardHit: () => hit },
  );
  await h.layer.update(h.viewer);
  assert.equal(h.owners.get('news-events')('news-event:x'), true);
  assert.equal(h.owners.get('news-events')('flight:x'), false);

  picked = { id: 'news-event:-1456928' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('news-events');
  assert.equal(card.title, 'NEWS · Paris, France');
  assert.equal(card.interactive, true);
  assert.equal(card.accent, '#ffb300');

  picked = null;
  hit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://a.example/top']);

  // A sibling layer's pick leaves the selection alone; empty space clears it.
  hit = null;
  picked = { id: 'other-layer:1' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.equal(h.overlay.entries.get('news-events').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.equal(h.overlay.entries.get('news-events').length, 0);

  h.layer.disable(h.viewer);
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.owners.has('news-events'), false);
});

test('the card states counts, the top reports and the caveat', () => {
  const card = buildNewsEventCard(row, Date.UTC(2026, 9, 25, 10), {
    link: null,
  });
  assert.deepEqual(card.details, [
    '4 articles in 24 h',
    'Violence 1 · Protest 3',
    'Protest · Police → Protester · a.example · 2h ago',
    'Violence · b.example · 4h ago',
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
