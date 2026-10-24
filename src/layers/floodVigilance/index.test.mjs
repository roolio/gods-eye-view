import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createFloodVigilanceLayer } from './index.js';
import { normalizeVigicruesSnapshot } from './records.js';
import { createFloodVigilanceSource } from './source.js';
import { floodVigilanceProxy } from '../../../server/providers/floodVigilance.js';
import {
  clickSeam,
  fakePicking,
  fakeViewer,
  recordingHost,
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
  const seam = clickSeam();
  const picking = fakePicking();
  const stackEvents = new EventTarget();
  const layer = createFloodVigilanceLayer({
    source,
    overlayHost: host,
    screenSpaceEventHandlerFactory: seam.factory,
    picking,
    pointer: { isPointerFree: () => true },
    mapStackEventTarget: stackEvents,
    now: () => NOW,
  });
  layer.init(viewer);
  return { layer, viewer, host, seam, picking, stackEvents, requests };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function lineSummary(viewer) {
  const collection = viewer.scene.groundPrimitives.get(0);
  return Array.from({ length: collection.length }, (_, i) => {
    const primitive = collection.get(i);
    const [first] = primitive.geometryInstances;
    const color = Cesium.Color.fromBytes(...first.attributes.color.value);
    return [
      primitive.geometryInstances.map((instance) => instance.id),
      first.geometry.width,
      color.toCssHexString(),
    ];
  });
}

test('enable draws one ground primitive per level, green thin and translucent under yellow', async () => {
  const { layer, viewer, requests } = setup();
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  // At 900 km only the bulletin is requested.
  assert.deepEqual(requests, ['/api/flood-vigilance/sections']);
  assert.deepEqual(lineSummary(viewer), [
    [['flood-vigilance:section:CO1'], 1.5, '#28d76173'],
    [
      [
        'flood-vigilance:section:AP12',
        'flood-vigilance:section:AP12',
        'flood-vigilance:section:AP6',
        'flood-vigilance:section:AP6',
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
  const { layer, viewer, host, seam } = setup();
  layer.enable(viewer);
  await layer.update();
  viewer.picked = { id: 'flood-vigilance:section:AP6' };
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
  const [card] = host.entries.get('flood-vigilance-card');
  assert.equal(card.title, 'FLOOD VIGILANCE · Liane');
  assert.deepEqual(card.details, [
    'Yellow: localised flooding or a rapid rise',
    'Vigicrues bulletin Oct 24, 07:55 UTC',
    'Section AP6',
  ]);
  assert.equal(card.accent, '#FFFF00');
  assert.ok(card.position instanceof Cesium.Cartesian3);
  viewer.picked = { id: 'other:aircraft' };
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
  assert.equal(host.entries.get('flood-vigilance-card').length, 1);
  viewer.picked = null;
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
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
  assert.equal(viewer.scene.groundPrimitives.length, 1);
  status = 429;
  await layer.update();
  assert.equal(layer.getStats().error, 'Vigicrues rate limited');
});

test('disable frees the primitives and the card, re-enable redraws without a new request', async () => {
  const { layer, viewer, host, seam, requests, stackEvents } = setup();
  layer.enable(viewer);
  await layer.update();
  viewer.picked = { id: 'flood-vigilance:section:CO1' };
  seam.click({ position: new Cesium.Cartesian2(1, 1) });
  stackEvents.dispatchEvent(
    Object.assign(new Event('gev:map-stack-changed'), {
      detail: { activeId: 'photoreal' },
    }),
  );
  const collection = viewer.scene.groundPrimitives.get(0);
  assert.equal(
    collection.get(0).classificationType,
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  layer.disable();
  assert.equal(viewer.scene.groundPrimitives.length, 0);
  assert.equal(seam.click, null);
  assert.equal(host.entries.has('flood-vigilance-card'), false);
  layer.enable(viewer);
  assert.equal(viewer.scene.groundPrimitives.length, 1);
  assert.equal(
    viewer.scene.groundPrimitives.get(0).get(0).classificationType,
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  assert.equal(requests.length, 1);
  layer.destroy();
  assert.equal(viewer.scene.groundPrimitives.length, 0);
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
  const { layer, viewer, host, seam, picking, requests } = setup({
    viewerOptions: { heightM: 20_000, lon: 2.35, lat: 48.85 },
  });
  layer.enable(viewer);
  await layer.update();
  await settle();
  assert.deepEqual(requests, [
    '/api/flood-vigilance/stations?west=0.850&south=47.850&east=3.850&north=49.850',
    '/api/flood-vigilance/sections',
  ]);
  const points = viewer.scene.primitives.get(0);
  assert.equal(points.length, 9);
  const colours = Array.from({ length: points.length }, (_, i) => {
    const point = points.get(i);
    return [point.id, point.color.toCssHexString()];
  });
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

  viewer.picked = { id: 'flood-vigilance:station:F700000103' };
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
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

  viewer.picked = { id: 'flood-vigilance:station:F664000601' };
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
  assert.deepEqual(host.entries.get('flood-vigilance-card')[0].details, [
    'No reading in the last 6 hours',
    "Hub'Eau station F664000601",
  ]);
});

test('climbing above 150 km hides the gauges and drops a station card; disable unregisters the picks', async () => {
  const { layer, viewer, host, seam, picking, requests } = setup({
    viewerOptions: { heightM: 20_000, lon: 2.35, lat: 48.85 },
  });
  layer.enable(viewer);
  await layer.update();
  await settle();
  viewer.picked = { id: 'flood-vigilance:station:F704000101' };
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
  assert.equal(host.entries.get('flood-vigilance-card').length, 1);

  viewer.camera.positionCartographic.height = 400_000;
  await layer.update();
  await settle();
  assert.equal(viewer.scene.primitives.get(0).show, false);
  assert.deepEqual(host.entries.get('flood-vigilance-stations'), []);
  assert.deepEqual(host.entries.get('flood-vigilance-card'), []);
  assert.equal(layer.getStats().stationCount, 0);
  assert.equal(requests.filter((url) => url.includes('stations')).length, 1);

  // Back down over the same tiles: cached for five minutes, no new request.
  viewer.camera.positionCartographic.height = 20_000;
  await layer.update();
  await settle();
  assert.equal(viewer.scene.primitives.get(0).show, true);
  assert.equal(requests.filter((url) => url.includes('stations')).length, 1);

  layer.disable();
  assert.equal(viewer.scene.primitives.length, 0);
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
