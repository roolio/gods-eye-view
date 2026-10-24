import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUNDLE_DIR = new URL(
  '../../data/local_data/idfm_transit_network/',
  import.meta.url,
);
const networkBytes = readFileSync(new URL('network.geojson', BUNDLE_DIR));
const sourceMeta = JSON.parse(
  readFileSync(new URL('source.json', BUNDLE_DIR), 'utf8'),
);
const features = JSON.parse(networkBytes.toString('utf8')).features;
const lineFeatures = features.filter(
  (feature) => feature.properties.kind === 'line',
);
const stations = features.filter(
  (feature) => feature.properties.kind === 'station',
);

function lineById() {
  const lines = new Map();
  for (const { properties } of lineFeatures)
    lines.set(properties.line, properties);
  return lines;
}

test('the bundle holds the 46 commercial lines in official colours', () => {
  const lines = lineById();
  assert.equal(lines.size, 46);
  assert.equal(lines.get('C01371').color, '#FFBE00');
  assert.equal(lines.get('C01743').color, '#5091CB');
  assert.equal(lines.get('C01739').color, '#CEC73D');
});

test('Châtelet is one station serving metro 1, 4, 7, 11 and 14', () => {
  const lines = lineById();
  const chatelet = stations.filter(
    (station) => station.properties.name === 'Châtelet',
  );
  assert.equal(chatelet.length, 1);
  assert.deepEqual(
    chatelet[0].properties.lineIds.map((id) => lines.get(id).code),
    ['1', '4', '7', '11', '14'],
  );
  assert.deepEqual(chatelet[0].geometry.coordinates, [2.34648, 48.85959]);
});

test('961 stations, none referring to a line outside the bundle', () => {
  const lines = lineById();
  assert.equal(stations.length, 961);
  const dangling = stations.flatMap((station) =>
    station.properties.lineIds.filter((id) => !lines.has(id)),
  );
  assert.deepEqual(dangling, []);
});

test('RER D is cased under RER B on the shared trunk', () => {
  const levels = lineFeatures
    .filter((feature) => feature.properties.line === 'C01728')
    .map((feature) => feature.properties.level);
  assert.deepEqual(levels, [0, 1, 2]);
});

test('the bundle stays small and matches its provenance record', () => {
  assert.ok(gzipSync(networkBytes, { level: 9 }).length < 150_000);
  const sha256 = createHash('sha256').update(networkBytes).digest('hex');
  assert.deepEqual(sourceMeta.files, [
    { path: 'network.geojson', bytes: networkBytes.length, sha256 },
  ]);
  assert.equal(sourceMeta.counts.stations, stations.length);
  assert.equal(sourceMeta.counts.strands, lineFeatures.length);
  assert.equal(sourceMeta.license.name, 'Licence Ouverte 2.0');
});
