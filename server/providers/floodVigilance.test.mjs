import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { floodVigilanceProxy } from './floodVigilance.js';

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
