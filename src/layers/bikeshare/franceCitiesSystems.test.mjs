import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';
import {
  parseStationInformation,
  parseStationStatus,
} from '../../sources/gbfsStations.js';

// Each system's host, its stations farthest from the registered centre, and
// the stations its live feed lists away from the city: unnamed or named
// stations at (0,0) and a workshop terminal outside Toulouse (checked
// 2026-10-24).
const SYSTEMS = {
  'lyon-velov': {
    host: 'api.cyclocity.fr',
    provider: "Vélo'v",
    stations: [
      { name: "ST GERMAIN AU MONT D'OR", lat: 45.887541, lon: 4.803999 },
      { name: 'NEUVILLE - QUAI PASTEUR', lat: 45.876622, lon: 4.838578 },
    ],
    strays: [{ station_id: '2', name: '', lat: 0, lon: 0 }],
  },
  'nantes-naolib': {
    host: 'api.cyclocity.fr',
    provider: 'Naolib',
    stations: [
      { name: 'FACULTÉS', lat: 47.246298, lon: -1.555309 },
      { name: 'LIBERTÉ', lat: 47.198124, lon: -1.588395 },
    ],
    strays: [{ station_id: '33', name: 'RACINE', lat: 0, lon: 0 }],
  },
  'toulouse-velotoulouse': {
    host: 'api.cyclocity.fr',
    provider: 'vélôToulouse',
    stations: [
      { name: 'PIQUEMIL - CATCHERE', lat: 43.612304, lon: 1.320033 },
      { name: 'ALLENDE - ADOUR', lat: 43.605128, lon: 1.32183 },
    ],
    strays: [
      {
        station_id: '1031',
        name: 'BORNE CGB ATELIER',
        lat: 43.615909,
        lon: 1.000176,
      },
    ],
  },
  'nancy-velostanlib': {
    host: 'api.cyclocity.fr',
    provider: "vélOstan'lib",
    stations: [
      { name: 'NATIONS', lat: 48.662356, lon: 6.173442 },
      { name: 'PLACE BARROIS', lat: 48.699502, lon: 6.204736 },
    ],
  },
  'paris-velib': {
    host: 'velib-metropole-opendata.smovengo.cloud',
    provider: "Vélib' Métropole",
    stations: [
      {
        name: '11 Novembre 1918 - 8 Mai 1945',
        lat: 48.80889533774377,
        lon: 2.5382421165704727,
      },
      {
        name: 'Martyrs de Châteaubriant - Jean Grandel',
        lat: 48.951432,
        lon: 2.211214,
      },
    ],
  },
};

// The production range check, with no viewer or fetches behind it.
const parts = {
  model: createModel({ state: {}, services: {}, parts: {}, source: null }),
};
const { computeInRangeCities } = createViewport({
  state: {},
  services: { render: { governorRequestRender() {} } },
  parts,
  source: null,
});

/** Station information for `id` through the real ingestion path. */
async function loadThroughIngestion(id, stations) {
  const city = CITY_BY_ID.get(id);
  const state = {
    _stationInfoCache: new Map(),
    _inFlightInfo: new Map(),
    _inFlightStatus: new Map(),
    _loadingOps: 0,
    _loading: false,
  };
  const ingestion = createIngestion({
    state,
    services: {},
    parts,
    source: {
      async getStations(url) {
        assert.equal(url, city.stationInformationUrl);
        return { data: { stations } };
      },
    },
  });
  return ingestion.loadCityStationInfo(id, 1);
}

test('the French city systems are registered and readable through the proxy', () => {
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    const system = CITY_BY_ID.get(id);
    assert.ok(system, `${id} is registered`);
    assert.equal(system.provider, expected.provider);
    assert.deepEqual(system.hosts, [expected.host]);
    for (const feed of [
      system.stationInformationUrl,
      system.stationStatusUrl,
    ]) {
      const url = new URL(feed);
      assert.ok(isAllowedGbfsHost(url.hostname), `${id} host ${url.hostname}`);
      assert.ok(
        isAllowedGbfsPath(url.pathname, url.hostname),
        `${id} path ${url.pathname}`,
      );
    }
  }
});

test("the proxy keeps Smovengo's host to Vélib's feeds", () => {
  const host = 'velib-metropole-opendata.smovengo.cloud';
  assert.ok(
    isAllowedGbfsPath('/opendata/Velib_Metropole/station_status.json', host),
  );
  assert.equal(isAllowedGbfsPath('/other/station_status.json', host), false);
});

test('a camera over each outermost station activates its system', () => {
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    for (const station of expected.stations) {
      assert.ok(
        computeInRangeCities({ lat: station.lat, lon: station.lon }).has(id),
        `${station.name} activates ${id}`,
      );
    }
  }
});

test('each load radius reaches its outermost stations', () => {
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    const system = CITY_BY_ID.get(id);
    for (const station of expected.stations) {
      const distance = parts.model.haversineKm(
        system.centerLat,
        system.centerLon,
        station.lat,
        station.lon,
      );
      assert.ok(
        distance <= system.loadRadiusKm,
        `${station.name} is ${distance.toFixed(1)} km from the ${id} centre`,
      );
    }
  }
});

test('a camera over central Paris activates Vélib', () => {
  // Hôtel de Ville.
  const active = computeInRangeCities({ lat: 48.8566, lon: 2.3522 });
  assert.ok(active.has('paris-velib'));
});

test('stations a feed lists away from its city are not loaded', async () => {
  for (const [id, expected] of Object.entries(SYSTEMS)) {
    if (!expected.strays) continue;
    const local = expected.stations.map((station, index) => ({
      station_id: `local-${index}`,
      ...station,
    }));
    const stations = await loadThroughIngestion(id, [
      ...local,
      ...expected.strays,
    ]);
    assert.deepEqual(
      [...stations.keys()],
      local.map((station) => station.station_id),
      `${id} keeps only its local stations`,
    );
  }
});

test("Vélib's numeric station ids join information and status", () => {
  // Hôpital Mondor as published on 2026-10-24: Vélib' sends station_id as a
  // JSON number in both feeds.
  const info = parseStationInformation({
    data: {
      stations: [
        {
          station_id: 19179944124,
          stationCode: '40001',
          name: 'Hôpital Mondor',
          lat: 48.798922410229,
          lon: 2.4537451531298,
          capacity: 28,
        },
      ],
    },
  });
  const status = parseStationStatus({
    data: {
      stations: [
        {
          station_id: 19179944124,
          num_bikes_available: 23,
          num_bikes_available_types: [{ mechanical: 19 }, { ebike: 4 }],
          num_docks_available: 4,
          is_installed: 1,
          is_returning: 1,
          is_renting: 1,
          last_reported: 1792829559,
        },
      ],
    },
  });
  const station = info.get('19179944124');
  assert.equal(station.name, 'Hôpital Mondor');
  assert.equal(station.capacity, 28);
  const live = status.get('19179944124');
  assert.equal(live.bikesAvailable, 23);
  assert.equal(live.docksAvailable, 4);
  assert.equal(live.isRenting, true);
});
