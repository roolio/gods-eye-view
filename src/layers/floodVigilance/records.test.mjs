import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COVERAGE,
  VIGILANCE_LEVELS,
  convertHubeauValue,
  heightTrend,
  joinStationReadings,
  normalizeHubeauStations,
  normalizeVigicruesSnapshot,
  simplifyLineMeters,
  stationIsStale,
  summarizeHubeauObservations,
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

test("recorded Hub'Eau stations and observations join into readings in metres and m³/s", () => {
  const stations = normalizeHubeauStations(
    fixture('hubeau-stations-paris.json'),
  );
  assert.equal(stations.length, 9);
  const summaries = summarizeHubeauObservations(
    fixture('hubeau-observations-paris.json').data,
  );
  const readings = joinStationReadings(stations, summaries);
  const austerlitz = readings.find(({ id }) => id === 'F700000103');
  assert.deepEqual(austerlitz, {
    id: 'F700000103',
    name: 'La Seine à Paris - Austerlitz [>2006] - Station débitmétrique',
    river: 'La Seine',
    lon: 2.365510635,
    lat: 48.84468962,
    // 976 mm and 91,600 l/s at 13:00 UTC.
    height: {
      value: 0.976,
      observedAt: Date.parse('2026-10-24T13:00:00Z'),
      method: 'Mesurée',
      qualification: 'Non qualifiée',
    },
    flow: {
      value: 91.6,
      observedAt: Date.parse('2026-10-24T13:00:00Z'),
      method: 'Mesurée',
      qualification: 'Non qualifiée',
    },
    // 976 mm against 970 mm at 12:00: under the 20 mm threshold.
    trend: { direction: 'steady', deltaM: 0.006, spanMs: 3600_000 },
  });
  const suresnes = readings.find(({ id }) => id === 'F704000101');
  assert.equal(suresnes.height.value, 5.603);
  assert.equal(suresnes.flow, null);
  // 5,603 mm against 5,582 mm at 12:00.
  assert.deepEqual(suresnes.trend, {
    direction: 'rising',
    deltaM: 0.021,
    spanMs: 3600_000,
  });
  const quiet = readings.find(({ id }) => id === 'F664000601');
  assert.deepEqual([quiet.height, quiet.flow, quiet.trend], [null, null, null]);
});

test('stations out of service, without coordinates or a code are dropped', () => {
  assert.deepEqual(
    normalizeHubeauStations({
      data: [
        {
          code_station: 'F700000103',
          longitude_station: 2.3,
          latitude_station: 48.8,
          libelle_station: ' ',
          en_service: true,
        },
        {
          code_station: 'F700000109',
          longitude_station: 2.3,
          latitude_station: 48.8,
          en_service: false,
        },
        {
          code_station: 'F700000110',
          longitude_station: null,
          latitude_station: 48.8,
        },
        {
          code_station: 'bad code',
          longitude_station: 2.3,
          latitude_station: 48.8,
        },
      ],
    }),
    [
      {
        id: 'F700000103',
        name: 'F700000103',
        river: null,
        lon: 2.3,
        lat: 48.8,
      },
    ],
  );
  assert.equal(normalizeHubeauStations({ count: 0 }), null);
});

test('H converts from millimetres and Q from litres per second', () => {
  assert.equal(convertHubeauValue('H', 976), 0.976);
  assert.equal(convertHubeauValue('Q', 91600), 91.6);
  assert.equal(convertHubeauValue('H', -120), -0.12);
  assert.equal(convertHubeauValue('V', 5), null);
  assert.equal(convertHubeauValue('H', null), null);
});

test('the trend compares with the reading closest to an hour earlier, within 45 to 90 minutes', () => {
  const at = (minutes, mm) => ({
    value: mm / 1000,
    observedAt: minutes * 60_000,
  });
  assert.deepEqual(heightTrend([at(120, 1500), at(65, 1400), at(40, 1000)]), {
    direction: 'rising',
    deltaM: 0.1,
    spanMs: 55 * 60_000,
  });
  assert.equal(
    heightTrend([at(120, 1000), at(55, 1100), at(40, 900)]).direction,
    'falling',
  );
  assert.equal(heightTrend([at(120, 1000), at(60, 1019)]).direction, 'steady');
  assert.equal(heightTrend([at(120, 1000), at(100, 900)]), null);
  assert.equal(heightTrend([at(120, 1000), at(20, 900)]), null);
  assert.equal(heightTrend([]), null);
});

test('a station is stale without any reading in the last six hours', () => {
  const now = Date.parse('2026-10-24T13:25:00Z');
  const reading = (iso) => ({ value: 1, observedAt: Date.parse(iso) });
  assert.equal(
    stationIsStale({ height: reading('2026-10-24T07:26:00Z') }, now),
    false,
  );
  assert.equal(
    stationIsStale({ height: reading('2026-10-24T07:24:00Z') }, now),
    true,
  );
  assert.equal(
    stationIsStale(
      {
        height: reading('2026-10-24T05:00:00Z'),
        flow: reading('2026-10-24T13:00:00Z'),
      },
      now,
    ),
    false,
  );
  assert.equal(stationIsStale({ height: null, flow: null }, now), true);
});
