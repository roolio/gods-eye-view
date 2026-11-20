import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { inputFor } from '../../input/dispatcher.js';
import { createFloodVigilanceLayer } from './index.js';
import { normalizeVigicruesSnapshot } from './records.js';
import { createFloodVigilanceSource } from './source.js';
import { createStationScene } from './stations.js';
import { floodVigilanceProxy } from '../../../server/providers/floodVigilance.js';
import {
  fakePicking,
  fakeViewer,
  hitOf,
  recordingHost,
  setsOf,
} from './testFixtures.mjs';

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );

const bulletin = () => ({
  fetchedAt: 1000,
  ...normalizeVigicruesSnapshot(fixture('vigicrues-infovigicru.json')),
});

const NOW = Date.parse('2026-10-24T13:25:00Z');

/**
 * Browser fetch routed through the real proxy, whose upstream answers from
 * the recorded Vigicrues and Hub'Eau extracts.
 */
function proxiedFetch(requests) {
  let handler;
  floodVigilanceProxy({
    now: () => NOW,
    fetchImpl: async (url) => {
      const name = url.includes('vigicrues')
        ? 'vigicrues-infovigicru.json'
        : url.includes('/referentiel/stations')
          ? 'hubeau-stations-paris.json'
          : 'hubeau-observations-paris.json';
      return new Response(
        readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
      );
    },
  }).configureServer({ middlewares: { use: (_, h) => (handler = h) } });
  return async (url) => {
    requests.push(url);
    let response;
    await handler(
      {
        url: url.slice('/api/flood-vigilance'.length),
        method: 'GET',
        socket: {},
      },
      {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          response = new Response(body, { status: this.status });
        },
      },
    );
    return response;
  };
}

function setup({ respond = null, viewerOptions = {} } = {}) {
  const requests = [];
  const fetchImpl = respond
    ? async (url) => {
        requests.push(url);
        return respond(url);
      }
    : proxiedFetch(requests);
  const source = createFloodVigilanceSource({ fetchImpl });
  const viewer = fakeViewer(viewerOptions);
  const host = recordingHost();
  const picking = fakePicking();
  const stackEvents = new EventTarget();
  const layer = createFloodVigilanceLayer({
    source,
    overlayHost: host,
    picking,
    mapStackEventTarget: stackEvents,
    now: () => NOW,
  });
  layer.init(viewer);
  return { layer, viewer, host, picking, stackEvents, requests };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const SECTIONS = 'flood-vigilance:sections';
const STATIONS = 'flood-vigilance:stations';

/** A renderer colour (`[r, g, b, a]`, 0..1) as `#rrggbb`, `aa` when not opaque. */
function hex([r, g, b, a = 1]) {
  const byte = (c) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a) : ''}`;
}

/** Each section set, in the order drawn: its item ids, width and colour. */
function lineSummary(viewer) {
  return setsOf(viewer, SECTIONS).map((set) => {
    const items = [...set.items.values()];
    const [first] = items;
    assert.ok(items.every((item) => item.mode === 'draped'));
    return [
      items.map((item) => item.id),
      first.widthPx,
      hex(first.style.color),
    ];
  });
}

/** The live station dots set. */
const stationDots = (viewer) => setsOf(viewer, STATIONS)[0] ?? null;
const clickSubscribers = (viewer) => inputFor(viewer).subscriberCount();

test('enable draws one draped line set per level, green thin and translucent under yellow', async () => {
  const { layer, viewer, requests } = setup();
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  // At 900 km only the bulletin is requested.
  assert.deepEqual(requests, ['/api/flood-vigilance/sections']);
  assert.deepEqual(lineSummary(viewer), [
    [['flood-vigilance:section:CO1:0'], 1.5, '#28d76173'],
    [
      [
        'flood-vigilance:section:AP12:0',
        'flood-vigilance:section:AP12:1',
        'flood-vigilance:section:AP6:0',
        'flood-vigilance:section:AP6:1',
      ],
      4,
      '#ffff00',
    ],
  ]);
  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  assert.deepEqual(stats.levels, { 1: 1, 2: 2, 3: 0, 4: 0 });
  assert.equal(stats.observedAt, Date.parse('2026-10-24T07:55:59Z'));
  assert.equal(stats.error, null);
  const legend = layer.getRowControls().legend;
  assert.deepEqual(
    legend.map(({ color, count }) => [color, count]),
    [
      ['#28D761', 1],
      ['#FFFF00', 2],
      ['#FFAA00', 0],
      ['#FF0000', 0],
    ],
  );
  assert.match(legend[0].blurb, /Oct 24, 07:55 UTC/);
  assert.equal(
    layer.getRowControls().info,
    '2 river sections above green · Zoom below 150 km to see gauging stations',
  );
  assert.equal(layer.getStats().stationCount, 0);
});

test('a click on a section opens its card, empty space closes it, another layer leaves it', async () => {
  const { layer, viewer, host } = setup();
  layer.enable(viewer);
  await layer.update();
  viewer.picked = hitOf(viewer, 'flood-vigilance:section:AP6:1');
  viewer.click();
  const [card] = host.entries.get('flood-vigilance-card');
  assert.equal(card.title, 'FLOOD VIGILANCE · Liane');
  assert.deepEqual(card.details, [
    'Yellow: localised flooding or a rapid rise',
    'Vigicrues bulletin Oct 24, 07:55 UTC',
    'Section AP6',
  ]);
  assert.equal(card.accent, '#FFFF00');
  assert.ok(
    ['x', 'y', 'z'].every((axis) => Number.isFinite(card.position[axis])),
  );
  viewer.picked = { set: 'aircraft', id: 'other:aircraft', surface: false };
  viewer.click();
  assert.equal(host.entries.get('flood-vigilance-card').length, 1);
  viewer.picked = null;
  viewer.click();
  assert.deepEqual(host.entries.get('flood-vigilance-card'), []);
  assert.equal(layer.getStats().selectedId, null);
});

test('a failed refresh keeps the layer on with its last bulletin and reports the error', async () => {
  let status = 200;
  const { layer, viewer } = setup({
    respond: () =>
      status === 200
        ? Response.json(bulletin())
        : new Response('{}', { status }),
  });
  layer.enable(viewer);
  await layer.update();
  status = 502;
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'Vigicrues HTTP 502');
  assert.equal(layer.getStats().count, 3);
  assert.equal(setsOf(viewer, SECTIONS).length, 2);
  status = 429;
  await layer.update();
  assert.equal(layer.getStats().error, 'Vigicrues rate limited');
});

test('disable frees the draw sets and the card, re-enable redraws without a new request', async () => {
  const { layer, viewer, host, requests, stackEvents } = setup();
  layer.enable(viewer);
  await layer.update();
  // The globe is shown: the lines drape on the terrain alone.
  assert.deepEqual(
    setsOf(viewer, SECTIONS).map((set) => set.spec.clampTo),
    ['terrain', 'terrain'],
  );
  const subscribers = clickSubscribers(viewer);
  viewer.picked = hitOf(viewer, 'flood-vigilance:section:CO1:0');
  viewer.click(1, 1);
  assert.equal(layer.getStats().selectedId, 'CO1');
  stackEvents.dispatchEvent(
    Object.assign(new Event('gev:map-stack-changed'), {
      detail: { activeId: 'photoreal' },
    }),
  );
  assert.deepEqual(
    setsOf(viewer, SECTIONS).map((set) => set.spec.clampTo),
    ['tiles', 'tiles'],
  );
  layer.disable();
  assert.equal(setsOf(viewer, SECTIONS).length, 0);
  assert.equal(clickSubscribers(viewer), subscribers - 1);
  assert.equal(host.entries.has('flood-vigilance-card'), false);
  layer.enable(viewer);
  assert.deepEqual(
    setsOf(viewer, SECTIONS).map((set) => set.spec.clampTo),
    ['tiles', 'tiles'],
  );
  assert.equal(requests.length, 1);
  layer.destroy();
  assert.equal(setsOf(viewer, SECTIONS).length, 0);
});

test('the source drops malformed sections and rejects a payload without them', async () => {
  const source = createFloodVigilanceSource({
    fetchImpl: async () =>
      Response.json({
        publishedAt: 5,
        sections: [
          { id: 'A', name: 'Ok', level: 2, paths: [[2, 48, 2.1, 48.1]] },
          { id: 'B', name: 'Odd', level: 2, paths: [[2, 48, 2.1]] },
          { id: 'C', name: 'Level', level: 9, paths: [[2, 48, 2.1, 48.1]] },
        ],
      }),
  });
  const result = await source.getSections();
  assert.deepEqual(
    result.sections.map(({ id }) => id),
    ['A'],
  );
  assert.equal(result.publishedAt, 5);
  assert.equal(result.stale, false);
  const broken = createFloodVigilanceSource({
    fetchImpl: async () => Response.json({ rows: [] }),
  });
  await assert.rejects(broken.getSections(), /Malformed Vigicrues response/);
});

test('below 150 km the gauges of the view load as dots with height labels, and a click opens a station card', async () => {
  const { layer, viewer, host, picking, requests } = setup({
    viewerOptions: { heightM: 20_000, lon: 2.35, lat: 48.85 },
  });
  layer.enable(viewer);
  await layer.update();
  await settle();
  assert.deepEqual(requests, [
    '/api/flood-vigilance/stations?west=0.850&south=47.850&east=3.850&north=49.850',
    '/api/flood-vigilance/sections',
  ]);
  const points = [...stationDots(viewer).items.values()];
  assert.equal(points.length, 9);
  assert.ok(
    points.every(
      (point) =>
        point.disableDepthTest === Infinity && point.outlineWidth === 2,
    ),
    'the dots draw over every surface, outlined',
  );
  const colours = points.map((point) => [point.id, hex(point.color)]);
  assert.deepEqual(
    colours.filter(([, colour]) => colour === '#38bdf8').map(([id]) => id),
    [
      'flood-vigilance:station:F700000103',
      'flood-vigilance:station:F704000101',
    ],
  );
  assert.equal(
    colours.filter(([, colour]) => colour === '#8a8f98').length,
    7,
    'stations without a reading in six hours are grey',
  );
  assert.deepEqual(
    host.entries.get('flood-vigilance-stations').map(({ title }) => title),
    ['5.60 m ↑', '0.98 m →'],
  );
  assert.equal(layer.getStats().stationCount, 9);
  assert.match(
    layer.getRowControls().info,
    /9 gauging stations in view, 7 without a reading for 6 h$/,
  );
  assert.equal(
    picking.owners.get('flood-vigilance')('flood-vigilance:station:F700000103'),
    true,
  );
  assert.equal(
    picking.owners.get('flood-vigilance')('flood-vigilance:section:AP6'),
    false,
  );

  viewer.picked = hitOf(viewer, 'flood-vigilance:station:F700000103');
  viewer.click();
  const [card] = host.entries.get('flood-vigilance-card');
  assert.equal(
    card.title,
    'GAUGE · La Seine à Paris - Austerlitz [>2006] - Station débitmétrique',
  );
  assert.deepEqual(card.details, [
    'Height 0.98 m · steady over 60 min',
    'Flow 91.6 m³/s',
    'Measured Oct 24, 13:00 UTC (25 minutes ago)',
    'Method: Mesurée · Qualification: Non qualifiée',
    "Hub'Eau station F700000103",
  ]);
  assert.equal(card.accent, '#38BDF8');

  viewer.picked = hitOf(viewer, 'flood-vigilance:station:F664000601');
  viewer.click();
  assert.deepEqual(host.entries.get('flood-vigilance-card')[0].details, [
    'No reading in the last 6 hours',
    "Hub'Eau station F664000601",
  ]);
});

test('climbing above 150 km hides the gauges and drops a station card; disable unregisters the picks', async () => {
  const { layer, viewer, host, picking, requests } = setup({
    viewerOptions: { heightM: 20_000, lon: 2.35, lat: 48.85 },
  });
  layer.enable(viewer);
  await layer.update();
  await settle();
  viewer.picked = hitOf(viewer, 'flood-vigilance:station:F704000101');
  viewer.click();
  assert.equal(host.entries.get('flood-vigilance-card').length, 1);

  viewer.setHeight(400_000);
  await layer.update();
  await settle();
  assert.equal(stationDots(viewer).show, false);
  assert.deepEqual(host.entries.get('flood-vigilance-stations'), []);
  assert.deepEqual(host.entries.get('flood-vigilance-card'), []);
  assert.equal(layer.getStats().stationCount, 0);
  assert.equal(requests.filter((url) => url.includes('stations')).length, 1);

  // Back down over the same tiles: cached for five minutes, no new request.
  viewer.setHeight(20_000);
  await layer.update();
  await settle();
  assert.equal(stationDots(viewer).show, true);
  assert.equal(requests.filter((url) => url.includes('stations')).length, 1);

  layer.disable();
  assert.equal(stationDots(viewer), null);
  assert.equal(picking.owners.has('flood-vigilance'), false);
});

test("a Hub'Eau failure leaves the bulletin untouched and shows on the row", async () => {
  const { layer, viewer } = setup({
    viewerOptions: { heightM: 20_000 },
    respond: (url) =>
      url.includes('stations')
        ? new Response('{}', { status: 502 })
        : Response.json(bulletin()),
  });
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  await settle();
  const stats = layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.count, 3);
  assert.equal(stats.stationError, "Hub'Eau HTTP 502");
  assert.match(
    layer.getRowControls().info,
    /Gauging stations: Hub'Eau HTTP 502$/,
  );
});

test('a low view asks only for the tiles it sees, a wide one for the capped box', async () => {
  const low = setup({
    viewerOptions: {
      heightM: 20_000,
      lon: 2.35,
      lat: 48.85,
      viewRectangle: [2.2, 48.75, 2.5, 48.95],
    },
  });
  low.layer.enable(low.viewer);
  await low.layer.update();
  await settle();
  assert.equal(
    low.requests[0],
    '/api/flood-vigilance/stations?west=2.200&south=48.750&east=2.500&north=48.950',
  );
  const wide = setup({
    viewerOptions: {
      heightM: 140_000,
      lon: 2.35,
      lat: 48.85,
      viewRectangle: [-10, 40, 20, 60],
    },
  });
  wide.layer.enable(wide.viewer);
  await wide.layer.update();
  await settle();
  assert.equal(
    wide.requests[0],
    '/api/flood-vigilance/stations?west=0.850&south=47.850&east=3.850&north=49.850',
  );
});

test('a gauge stands 2 m above the loaded terrain, or above the ellipsoid where the globe is hidden', () => {
  const viewer = fakeViewer({ heightM: 20_000, lon: 2.35, lat: 48.85 });
  const station = { id: 'S1', name: 'Gauge', lon: 2.35, lat: 48.85 };
  viewer.renderer.testing.cacheHeight({ lon: 2.35, lat: 48.85 }, 30, 'terrain');
  const heightOf = (scene) =>
    toLonLatH(scene.records[0].position).height.toFixed(3);
  const onTerrain = createStationScene(viewer, [station], NOW);
  assert.equal(heightOf(onTerrain), '32.000');
  onTerrain.dispose();
  viewer.renderer.globe.setGlobeVisible(false);
  const onTiles = createStationScene(viewer, [station], NOW);
  assert.equal(heightOf(onTiles), '2.000');
  onTiles.dispose();
  assert.equal(stationDots(viewer), null);
});

test('a click on a card painted over a section leaves the selection alone', async () => {
  const { layer, viewer, host, picking } = setup();
  layer.enable(viewer);
  await layer.update();
  viewer.picked = hitOf(viewer, 'flood-vigilance:section:AP6:0');
  viewer.click();
  assert.equal(layer.getStats().selectedId, 'AP6');
  picking.clickCard = () => ({ sourceId: 'other-card', entryId: 'x' });
  viewer.picked = null;
  viewer.click();
  assert.equal(layer.getStats().selectedId, 'AP6');
  assert.equal(host.entries.get('flood-vigilance-card').length, 1);
});
