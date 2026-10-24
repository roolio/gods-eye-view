import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createBundledTransitNetworkSource } from './source.js';

const BUNDLE_DIR = new URL(
  '../../data/local_data/idfm_transit_network/',
  import.meta.url,
);
const networkBytes = readFileSync(new URL('network.geojson', BUNDLE_DIR));
const sourceMeta = JSON.parse(
  readFileSync(new URL('source.json', BUNDLE_DIR), 'utf8'),
);
const network = await createBundledTransitNetworkSource({
  fetchImpl: async () => ({
    ok: true,
    json: async () => JSON.parse(networkBytes.toString('utf8')),
  }),
}).fetch();
const lineById = new Map(network.lines.map((line) => [line.id, line]));

test('the bundle holds the 46 commercial lines in official colours', () => {
  assert.equal(network.lines.length, 46);
  assert.equal(lineById.get('C01371').color, '#FFBE00');
  assert.equal(lineById.get('C01743').color, '#5091CB');
  assert.equal(lineById.get('C01739').color, '#CEC73D');
});

test('Châtelet is one station serving metro 1, 4, 7, 11 and 14', () => {
  const chatelet = network.stations.filter(
    (station) => station.name === 'Châtelet',
  );
  assert.equal(chatelet.length, 1);
  assert.deepEqual(
    chatelet[0].lines.map((line) => line.code),
    ['1', '4', '7', '11', '14'],
  );
  assert.deepEqual([chatelet[0].lon, chatelet[0].lat], [2.34648, 48.85959]);
});

test('961 stations, each serving lines from the bundle', () => {
  assert.equal(network.stations.length, 961);
  const foreign = network.stations.flatMap((station) =>
    station.lines.filter((line) => lineById.get(line.id) !== line),
  );
  assert.deepEqual(foreign, []);
});

test('RER D is cased under RER B on the shared trunk', () => {
  const levelsOf = (id) =>
    network.strandsByLevel.flatMap((strands, level) =>
      strands.some((strand) => strand.line.id === id) ? [level] : [],
    );
  assert.deepEqual(levelsOf('C01728'), [0, 1, 2]);
  assert.deepEqual(levelsOf('C01743'), [0, 1]);
  assert.deepEqual(
    network.strandsByLevel.map((strands) => strands.length),
    [46, 25, 8, 2],
  );
});

test('the bundle stays small and matches its provenance record', () => {
  assert.ok(gzipSync(networkBytes, { level: 9 }).length < 150_000);
  const sha256 = createHash('sha256').update(networkBytes).digest('hex');
  assert.deepEqual(sourceMeta.files, [
    { path: 'network.geojson', bytes: networkBytes.length, sha256 },
  ]);
  assert.equal(sourceMeta.counts.stations, network.stations.length);
  assert.equal(sourceMeta.license.name, 'Licence Ouverte 2.0');
});
