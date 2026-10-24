import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  LINES,
  collection,
  lineFeature,
  parseNetwork,
  stationFeature,
} from './testFixtures.mjs';

const tinyNetwork = () =>
  collection([
    lineFeature(LINES.M1, 0, [
      [
        [2.3, 48.86],
        [2.31, 48.86],
      ],
    ]),
    stationFeature('gare:1', 'Louvre', ['C01371'], [2.3, 48.86]),
  ]);

test('fetches the one bundled asset with force-cache and the caller signal', async () => {
  const { createBundledTransitNetworkSource } = await import('./source.js');
  const requests = [];
  const source = createBundledTransitNetworkSource({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => tinyNetwork() };
    },
  });
  const controller = new AbortController();
  const network = await source.fetch(controller.signal);

  assert.equal(source.label, 'Île-de-France Mobilités');
  assert.equal(requests.length, 1);
  assert.match(
    requests[0].url,
    /\/data\/local_data\/idfm_transit_network\/network\.geojson$/,
  );
  assert.deepEqual(requests[0].init, {
    signal: controller.signal,
    cache: 'force-cache',
  });
  const metro1 = {
    id: 'C01371',
    code: '1',
    name: 'Métro 1',
    mode: 'metro',
    color: '#FFBE00',
    rank: 14,
  };
  assert.deepEqual(network, {
    lines: [metro1],
    strandsByLevel: [
      [{ line: metro1, level: 0, paths: [[2.3, 48.86, 2.31, 48.86]] }],
      [],
      [],
      [],
    ],
    stations: [
      { id: 'gare:1', name: 'Louvre', lon: 2.3, lat: 48.86, lines: [metro1] },
    ],
  });
  assert.equal(network.stations[0].lines[0], network.lines[0]);
  assert.equal(network.strandsByLevel[0][0].line, network.lines[0]);
});

test('rejects an HTTP failure and an aborted request', async () => {
  const { createBundledTransitNetworkSource } = await import('./source.js');
  const failing = createBundledTransitNetworkSource({
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  await assert.rejects(failing.fetch(), /HTTP 404 for .*network\.geojson/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(failing.fetch(controller.signal), {
    name: 'AbortError',
  });
});

test('rejects malformed bundles with the offending feature named', async () => {
  const withLine = (patch) => {
    const json = tinyNetwork();
    Object.assign(json.features[0].properties, patch);
    return json;
  };
  const cases = [
    [{ type: 'Feature' }, /expected a FeatureCollection/],
    [withLine({ mode: 'bus' }), /line feature C01371:0: unknown mode "bus"/],
    [
      withLine({ color: '#ffbe00' }),
      /line feature C01371:0: bad colour "#ffbe00"/,
    ],
    [withLine({ level: 4 }), /line feature C01371:0: level 4 outside 0\.\.3/],
    [
      collection([
        tinyNetwork().features[0],
        stationFeature('gare:9', 'Nulle part', ['C9'], [2.3, 48.86]),
      ]),
      /station gare:9: unknown line "C9"/,
    ],
    [
      collection([
        tinyNetwork().features[0],
        stationFeature('gare:9', 'Nulle part', ['C01371'], [null, 48.86]),
      ]),
      /station gare:9: invalid position \[null,48\.86\]/,
    ],
  ];
  for (const [json, expected] of cases) {
    await assert.rejects(parseNetwork(json), expected);
  }
});

test('importing the source touches no browser global', () => {
  const probe = `
    const touched = [];
    for (const name of ['window', 'document', 'navigator', 'location', 'self']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() { touched.push(name); return undefined; },
      });
    }
    const module = await import(${JSON.stringify(new URL('./source.js', import.meta.url).href)});
    module.createBundledTransitNetworkSource();
    console.log(JSON.stringify(touched));
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', probe],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '[]');
});
