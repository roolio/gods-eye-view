import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_STATION_TILES,
  floodStationTiles,
  floodVigilanceProxy,
} from './floodVigilance.js';

const fixture = (name) =>
  readFileSync(
    new URL(
      `../../src/layers/floodVigilance/fixtures/${name}`,
      import.meta.url,
    ),
    'utf8',
  );

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = floodVigilanceProxy(options);
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/flood-vigilance');
        handler = callback;
      },
    },
  });
  return async (url, method = 'GET') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: 'local' } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: sections come from the fixed Vigicrues URL, simplified and dated`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 5000,
        fetchImpl: async (url, options) => {
          calls.push(url);
          assert.equal(options.redirect, 'error');
          assert.ok(options.signal instanceof AbortSignal);
          return new Response(fixture('vigicrues-infovigicru.json'));
        },
      },
      hook,
    );
    const res = await request(
      '/sections?url=https://attacker.example/x.geojson',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [
      'https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson',
    ]);
    assert.equal(res.body.fetchedAt, 5000);
    assert.equal(res.body.publishedAt, Date.parse('2026-10-24T07:55:59Z'));
    assert.deepEqual(
      res.body.sections.map(({ id, level }) => [id, level]),
      [
        ['AP12', 2],
        ['AP6', 2],
        ['CO1', 1],
      ],
    );
    assert.equal(res.body.stale, undefined);
  });
}

test('sections are cached for ten minutes, then a failed refresh serves the last bulletin as stale', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (fail) return new Response('busy', { status: 503 });
      return new Response(fixture('vigicrues-infovigicru.json'));
    },
  });
  assert.equal((await request('/sections')).status, 200);
  clock = 9 * 60_000;
  assert.equal((await request('/sections')).status, 200);
  assert.equal(calls, 1);
  clock = 11 * 60_000;
  fail = true;
  const stale = await request('/sections');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(calls, 2);
  // The failure cooldown holds the next attempt back.
  clock += 10_000;
  assert.equal((await request('/sections')).body.stale, true);
  assert.equal(calls, 2);
});

test('an unusable upstream answer is a 502, and routes and methods are bounded', async () => {
  const request = install({
    fetchImpl: async () => Response.json({ type: 'FeatureCollection' }),
  });
  const res = await request('/sections');
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'flood_vigilance_unavailable' });
  assert.equal((await request('/sections', 'POST')).status, 405);
  assert.equal((await request('/elsewhere')).status, 404);
});

const NOW = Date.parse('2026-10-24T13:25:00Z');

/** Upstream double: Hub'Eau answers from the recorded Paris extracts. */
function hubeau({
  observations = () => fixture('hubeau-observations-paris.json'),
} = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname.endsWith('/referentiel/stations'))
        return new Response(fixture('hubeau-stations-paris.json'));
      if (parsed.pathname.endsWith('/observations_tr')) {
        const body = observations(parsed, calls);
        return typeof body === 'string' ? new Response(body) : body;
      }
      return new Response('{}', { status: 404 });
    },
  };
}

const params = (query) => new URLSearchParams(query);

test('station requests snap outward to whole-degree tiles inside the coverage', () => {
  assert.deepEqual(
    floodStationTiles(params('west=2.1&south=48.6&east=2.6&north=49')),
    {
      tiles: [{ west: 2, south: 48 }],
      bbox: { west: 2, south: 48, east: 3, north: 49 },
    },
  );
  // Clipped to the coverage before snapping: -8 becomes -5.5, then -6.
  assert.deepEqual(
    floodStationTiles(params('west=-8&south=47.5&east=-4.5&north=48.5')).bbox,
    { west: -6, south: 47, east: -4, north: 49 },
  );
  assert.deepEqual(
    floodStationTiles(params('west=20&south=40&east=21&north=41')),
    { tiles: [], bbox: null },
  );
  assert.equal(
    floodStationTiles(params('west=0.5&south=47.5&east=3.5&north=49.5')).tiles
      .length,
    MAX_STATION_TILES,
  );
  for (const query of [
    'west=0&south=47&east=4&north=51',
    'west=-5&south=42&east=9&north=51',
  ])
    assert.deepEqual(floodStationTiles(params(query)), {
      error: 'bbox_too_large',
    });
  for (const query of [
    '',
    'west=2&south=48&east=2&north=49',
    'west=3&south=48&east=2&north=49',
    'west=2&south=48&east=3',
    'west=x&south=48&east=3&north=49',
    'west=-200&south=48&east=3&north=49',
  ])
    assert.deepEqual(floodStationTiles(params(query)), {
      error: 'invalid_bbox',
    });
});

test("stations are read per tile from fixed Hub'Eau URLs and joined with their newest readings", async () => {
  const upstream = hubeau();
  const request = install({ now: () => NOW, fetchImpl: upstream.fetchImpl });
  const res = await request(
    '/stations?west=2.1&south=48.6&east=2.6&north=49&url=https://attacker.example/',
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bbox, { west: 2, south: 48, east: 3, north: 49 });
  assert.deepEqual(
    upstream.calls.map(({ origin, pathname, searchParams }) => [
      origin + pathname,
      searchParams.get('bbox'),
    ]),
    [
      [
        'https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations',
        '2,48,3,49',
      ],
      [
        'https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr',
        '2,48,3,49',
      ],
    ],
  );
  const observations = upstream.calls[1].searchParams;
  assert.equal(observations.get('grandeur_hydro'), 'H,Q');
  // Hub'Eau does not answer observations_tr without a start date.
  assert.equal(observations.get('date_debut_obs'), '2026-10-24T07:25:00Z');
  assert.equal(upstream.calls[0].searchParams.get('en_service'), 'true');
  assert.equal(res.body.stations.length, 9);
  const austerlitz = res.body.stations.find(({ id }) => id === 'F700000103');
  assert.equal(austerlitz.height.value, 0.976);
  assert.equal(austerlitz.flow.value, 91.6);
  assert.equal(austerlitz.trend.direction, 'steady');
  assert.equal(res.body.partial, false);
  assert.equal(res.body.stale, false);

  // The same tile is served from cache for another view inside it.
  const again = await request(
    '/stations?west=2.2&south=48.2&east=2.9&north=48.9',
  );
  assert.equal(again.status, 200);
  assert.equal(upstream.calls.length, 2);
});

test('pagination follows only the cursor, and a view past the page cap is partial', async () => {
  let pages = 0;
  const upstream = hubeau({
    observations: () => {
      pages++;
      return JSON.stringify({
        data: JSON.parse(fixture('hubeau-observations-paris.json')).data,
        next: `https://evil.example/steal?cursor=page${pages}`,
      });
    },
  });
  const request = install({ now: () => NOW, fetchImpl: upstream.fetchImpl });
  const res = await request('/stations?west=2.1&south=48.6&east=2.6&north=49');
  assert.equal(res.status, 200);
  const pageCalls = upstream.calls.filter(({ pathname }) =>
    pathname.endsWith('/observations_tr'),
  );
  assert.deepEqual(
    pageCalls.map(({ hostname, searchParams }) => [
      hostname,
      searchParams.get('cursor'),
    ]),
    [
      ['hubeau.eaufrance.fr', null],
      ['hubeau.eaufrance.fr', 'page1'],
      ['hubeau.eaufrance.fr', 'page2'],
    ],
  );
  assert.equal(res.body.partial, true);
});

test('a failed tile makes the answer partial, all failed tiles a 502, and old readings serve as stale', async () => {
  let clock = NOW;
  let failing = false;
  const upstream = hubeau({
    observations: (url) =>
      failing || url.searchParams.get('bbox') === '3,48,4,49'
        ? new Response('busy', { status: 503 })
        : fixture('hubeau-observations-paris.json'),
  });
  const request = install({ now: () => clock, fetchImpl: upstream.fetchImpl });
  const both = await request(
    '/stations?west=2.5&south=48.2&east=3.5&north=48.8',
  );
  assert.equal(both.status, 200);
  assert.equal(both.body.partial, true);
  assert.equal(both.body.stations.length, 9);

  assert.equal(
    (await request('/stations?west=3.2&south=48.2&east=3.8&north=48.8')).status,
    502,
  );

  clock += 6 * 60_000;
  failing = true;
  const stale = await request(
    '/stations?west=2.2&south=48.2&east=2.8&north=48.8',
  );
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');

  assert.equal(
    (await request('/stations?west=-3&south=44&east=3&north=48')).status,
    400,
  );
});
