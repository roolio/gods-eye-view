import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COVERAGE,
  VIGILANCE_LEVELS,
  normalizeVigicruesSnapshot,
  simplifyLineMeters,
  vigilanceLevel,
} from './records.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );

test('a recorded InfoVigiCru extract parses into dated, levelled sections', () => {
  const snapshot = normalizeVigicruesSnapshot(
    fixture('vigicrues-infovigicru.json'),
  );
  assert.equal(snapshot.publishedAt, Date.parse('2026-10-24T07:55:59+00:00'));
  assert.equal(snapshot.reference, '24102026_10');
  assert.deepEqual(
    snapshot.sections.map(({ id, name, level, paths }) => [
      id,
      name,
      level,
      paths.length,
    ]),
    [
      ['AP12', 'Hem', 2, 2],
      ['AP6', 'Liane', 2, 2],
      ['CO1', 'Golo aval', 1, 1],
    ],
  );
  const golo = snapshot.sections.find(({ id }) => id === 'CO1');
  const [path] = golo.paths;
  assert.equal(path.length % 2, 0);
  assert.ok(path.length / 2 < 104, 'simplified below the 104 source points');
  assert.deepEqual(path.slice(0, 2), [9.1953, 42.4828]);
  for (let i = 0; i < path.length; i += 2) {
    assert.ok(path[i] >= COVERAGE.west && path[i] <= COVERAGE.east);
    assert.ok(path[i + 1] >= COVERAGE.south && path[i + 1] <= COVERAGE.north);
  }
});

test('sections without a valid level, id or line are dropped, duplicates merge', () => {
  const line = [
    [2, 48],
    [2.01, 48.01],
  ];
  const feature = (props, coordinates = [line]) => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'MultiLineString', coordinates },
  });
  const snapshot = normalizeVigicruesSnapshot({
    type: 'FeatureCollection',
    DtHrInfoVigiCru: 'not a date',
    features: [
      feature({ CdEntCru: 'A1', lbentcru: 'Alpha', NivInfViCr: 1 }),
      feature({ CdEntCru: 'A1', lbentcru: 'Alpha', NivInfViCr: 3 }),
      feature({ CdEntCru: 'B2', NivInfViCr: 5 }),
      feature({ CdEntCru: 'C3', NivInfViCr: '2' }),
      feature({ CdEntCru: ' ', NivInfViCr: 2 }),
      feature({ CdEntCru: 'D4', NivInfViCr: 2 }, [[[2, 48]]]),
      feature({ CdEntCru: 'E5', NivInfViCr: 4 }, [
        [
          [2, 48],
          [NaN, 48],
          [2.02, 48.02],
        ],
      ]),
    ],
  });
  assert.equal(snapshot.publishedAt, null);
  assert.equal(snapshot.reference, null);
  assert.deepEqual(
    snapshot.sections.map(({ id, name, level, paths }) => [
      id,
      name,
      level,
      paths,
    ]),
    [
      [
        'A1',
        'Alpha',
        3,
        [
          [2, 48, 2.01, 48.01],
          [2, 48, 2.01, 48.01],
        ],
      ],
      ['E5', 'E5', 4, [[2, 48, 2.02, 48.02]]],
    ],
  );
  assert.equal(normalizeVigicruesSnapshot({ features: [] }), null);
  assert.equal(normalizeVigicruesSnapshot(null), null);
});

test('simplification drops points within the tolerance in metres, not degrees', () => {
  // 0.0005° of latitude is ~56 m; at 60°N, 0.001° of longitude is ~56 m.
  const kink = [
    [0, 0],
    [0.01, 0.0005],
    [0.02, 0],
  ];
  assert.equal(simplifyLineMeters(kink, 40).length, 3);
  assert.equal(simplifyLineMeters(kink, 70).length, 2);
  const north = [
    [0, 60],
    [0.001, 60.01],
    [0, 60.02],
  ];
  assert.equal(simplifyLineMeters(north, 40).length, 3);
  assert.equal(simplifyLineMeters(north, 70).length, 2);
  assert.deepEqual(simplifyLineMeters(kink.slice(0, 2), 1e6), kink.slice(0, 2));
});

test('levels follow the official Vigicrues palette, 1 to 4', () => {
  assert.deepEqual(
    VIGILANCE_LEVELS.map(({ level, color }) => [level, color]),
    [
      [1, '#28D761'],
      [2, '#FFFF00'],
      [3, '#FFAA00'],
      [4, '#FF0000'],
    ],
  );
  assert.equal(vigilanceLevel(0), null);
  assert.equal(vigilanceLevel(4).color, '#FF0000');
  assert.deepEqual(COVERAGE, { west: -5.5, south: 41, east: 10, north: 51.5 });
});
