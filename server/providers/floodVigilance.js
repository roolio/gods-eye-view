import {
  COVERAGE,
  STATION_STALE_AFTER_MS,
  joinStationReadings,
  normalizeHubeauStations,
  normalizeVigicruesSnapshot,
  summarizeHubeauObservations,
} from '../../src/layers/floodVigilance/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { requiredFiniteQueryNumber } from './common/query.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Vigicrues national flood bulletin (keyless, Licence Ouverte). It is
// published at 10:00 and 16:00 local time plus exceptional updates; the raw
// collection is ~2.2 MB, so the proxy simplifies it once per refresh.
const VIGICRUES_URL =
  'https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson';
const SECTIONS_TTL_MS = 10 * 60_000;
/** A failed refresh keeps serving the last bulletin for this long. */
const SECTIONS_STALE_MAX_MS = 24 * 3600_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MIB = 1024 * 1024;
const USER_AGENT = 'gods-eye-view-flood-vigilance/1.0';

// Hub'Eau Hydrométrie v2 (keyless, Licence Ouverte). France has about 4,000
// stations in service, so only whole-degree tiles under the view are read,
// and Hub'Eau does the spatial filtering. observations_tr needs a start date:
// without one it does not answer.
const HUBEAU_ROOT = 'https://hubeau.eaufrance.fr/api/v2/hydrometrie';
const STATION_FIELDS = [
  'code_station',
  'libelle_station',
  'longitude_station',
  'latitude_station',
  'libelle_cours_eau',
  'en_service',
].join(',');
const OBSERVATION_FIELDS = [
  'code_station',
  'date_obs',
  'resultat_obs',
  'grandeur_hydro',
  'libelle_methode_obs',
  'libelle_qualification_obs',
].join(',');
/** A view may span at most this many one-degree tiles. */
export const MAX_STATION_TILES = 12;
const STATIONS_TTL_MS = 24 * 3600_000;
const OBSERVATIONS_TTL_MS = 5 * 60_000;
/** A failed observation refresh keeps serving the last one this long. */
const OBSERVATIONS_STALE_MAX_MS = 3600_000;
/** One page holds a Paris tile's six hours of H and Q (~4,600 rows, ~0.8 MB). */
const OBSERVATION_PAGE_SIZE = 20_000;
const OBSERVATION_MAX_PAGES = 3;
const STATION_TILE_CACHE_MAX = 256;
const OBSERVATION_TILE_CACHE_MAX = 64;
const MAX_TILE_LOADS = 16;
const TILE_CONCURRENCY = 4;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,512}$/;

/**
 * Bound a requested view to whole-degree tiles inside the coverage.
 * @param {URLSearchParams} params west, south, east, north in degrees.
 * @returns {{tiles: Array<{west: number, south: number}>, bbox: object|null}|{error: string}}
 */
export function floodStationTiles(params) {
  const [west, south, east, north] = ['west', 'south', 'east', 'north'].map(
    (key) => requiredFiniteQueryNumber(params, key),
  );
  if (
    [west, south, east, north].some((value) => value === null) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  )
    return { error: 'invalid_bbox' };
  const clipped = {
    west: Math.max(west, COVERAGE.west),
    south: Math.max(south, COVERAGE.south),
    east: Math.min(east, COVERAGE.east),
    north: Math.min(north, COVERAGE.north),
  };
  if (clipped.west >= clipped.east || clipped.south >= clipped.north)
    return { tiles: [], bbox: null };
  const bbox = {
    west: Math.floor(clipped.west),
    south: Math.floor(clipped.south),
    east: Math.ceil(clipped.east),
    north: Math.ceil(clipped.north),
  };
  if ((bbox.east - bbox.west) * (bbox.north - bbox.south) > MAX_STATION_TILES)
    return { error: 'bbox_too_large' };
  const tiles = [];
  for (let lon = bbox.west; lon < bbox.east; lon++)
    for (let lat = bbox.south; lat < bbox.north; lat++)
      tiles.push({ west: lon, south: lat });
  return { tiles, bbox };
}

const tileBbox = ({ west, south }) =>
  `${west},${south},${west + 1},${south + 1}`;

/** Fixed-origin, bounded Vigicrues and Hub'Eau routes for dev and preview. */
export function floodVigilanceProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  let sections = null;
  let sectionsFailedAt = -Infinity;

  async function upstreamJson(url, maxBytes, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, maxBytes, signal);
  }

  async function loadSections() {
    const payload = await upstreamJson(VIGICRUES_URL, 16 * MIB, 30_000);
    const snapshot = normalizeVigicruesSnapshot(payload);
    if (!snapshot?.sections.length) throw new Error('invalid_snapshot');
    return { fetchedAt: now(), ...snapshot };
  }

  async function acquireSections() {
    const age = sections ? now() - sections.fetchedAt : Infinity;
    if (age >= 0 && age < SECTIONS_TTL_MS)
      return { value: sections, stale: false };
    try {
      if (now() - sectionsFailedAt < FAILURE_COOLDOWN_MS)
        throw new Error('cooling_down');
      const { promise } = coalesceProxyRequest(inFlight, 'sections', () =>
        loadSections(),
      );
      sections = await promise;
      return { value: sections, stale: false };
    } catch (error) {
      if (error.message !== 'cooling_down') sectionsFailedAt = now();
      if (sections && now() - sections.fetchedAt < SECTIONS_STALE_MAX_MS)
        return { value: sections, stale: true };
      throw error;
    }
  }

  const stationTiles = new Map();
  const observationTiles = new Map();
  const tileFailedAt = new Map();

  function remember(store, key, entry, max) {
    store.delete(key);
    store.set(key, entry);
    while (store.size > max) store.delete(store.keys().next().value);
  }

  async function loadTileStations(tile) {
    const query = new URLSearchParams({
      bbox: tileBbox(tile),
      en_service: 'true',
      fields: STATION_FIELDS,
      format: 'json',
      size: '10000',
    });
    const payload = await upstreamJson(
      `${HUBEAU_ROOT}/referentiel/stations?${query}`,
      8 * MIB,
      20_000,
    );
    const stations = normalizeHubeauStations(payload);
    if (!stations) throw new Error('invalid_stations');
    return stations;
  }

  async function loadTileObservations(tile) {
    const start = new Date(now() - STATION_STALE_AFTER_MS);
    const rows = [];
    let cursor = '';
    let partial = false;
    for (let page = 0; page < OBSERVATION_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        bbox: tileBbox(tile),
        grandeur_hydro: 'H,Q',
        date_debut_obs: start.toISOString().slice(0, 19) + 'Z',
        fields: OBSERVATION_FIELDS,
        format: 'json',
        size: String(OBSERVATION_PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      const payload = await upstreamJson(
        `${HUBEAU_ROOT}/observations_tr?${query}`,
        24 * MIB,
        30_000,
      );
      if (!Array.isArray(payload?.data))
        throw new Error('invalid_observations');
      rows.push(...payload.data);
      // Only the cursor is taken from `next`; the URL is always rebuilt here.
      let next = null;
      try {
        next = payload.next ? new URL(payload.next).searchParams : null;
      } catch {
        next = null;
      }
      cursor = next?.get('cursor') ?? '';
      if (!cursor || !CURSOR.test(cursor) || !payload.data.length) break;
      if (page === OBSERVATION_MAX_PAGES - 1) partial = true;
    }
    return { summaries: summarizeHubeauObservations(rows), partial };
  }

  /** One cached tile value, refreshed through a coalesced, cooled-down load. */
  async function acquireTile(store, kind, tile, ttl, staleMax, max, load) {
    const key = `${kind}:${tileBbox(tile)}`;
    const previous = store.get(key);
    const age = previous ? now() - previous.savedAt : Infinity;
    if (age >= 0 && age < ttl) return { value: previous.value, stale: false };
    try {
      if (now() - (tileFailedAt.get(key) ?? -Infinity) < FAILURE_COOLDOWN_MS)
        throw new Error('cooling_down');
      if (!inFlight.has(key) && inFlight.size >= MAX_TILE_LOADS)
        throw new Error('busy');
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load(tile);
        remember(store, key, { value, savedAt: now() }, max);
        tileFailedAt.delete(key);
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (error.message !== 'cooling_down' && error.message !== 'busy')
        tileFailedAt.set(key, now());
      if (previous && age >= 0 && age < staleMax)
        return { value: previous.value, stale: true };
      throw error;
    }
  }

  async function acquireStations({ tiles, bbox }) {
    const results = new Array(tiles.length);
    let index = 0;
    const worker = async () => {
      while (index < tiles.length) {
        const i = index++;
        try {
          const [stations, observations] = await Promise.all([
            acquireTile(
              stationTiles,
              'stations',
              tiles[i],
              STATIONS_TTL_MS,
              7 * STATIONS_TTL_MS,
              STATION_TILE_CACHE_MAX,
              loadTileStations,
            ),
            acquireTile(
              observationTiles,
              'observations',
              tiles[i],
              OBSERVATIONS_TTL_MS,
              OBSERVATIONS_STALE_MAX_MS,
              OBSERVATION_TILE_CACHE_MAX,
              loadTileObservations,
            ),
          ]);
          results[i] = { stations, observations };
        } catch {
          results[i] = null;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TILE_CONCURRENCY, tiles.length) }, worker),
    );
    const loaded = results.filter(Boolean);
    if (tiles.length && !loaded.length) throw new Error('upstream_unavailable');
    const byId = new Map();
    for (const { stations, observations } of loaded)
      for (const reading of joinStationReadings(
        stations.value,
        observations.value.summaries,
      ))
        byId.set(reading.id, reading);
    return {
      fetchedAt: now(),
      bbox,
      stations: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
      partial:
        loaded.length < tiles.length ||
        loaded.some(({ observations }) => observations.value.partial),
      stale: loaded.some(
        ({ stations, observations }) => stations.stale || observations.stale,
      ),
    };
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(status === 502 ? { 'Retry-After': '30' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const [path, search = ''] = (req.url || '/').split('?');
    if (path !== '/sections' && path !== '/stations')
      return json(404, { error: 'unknown_route' });
    const request =
      path === '/stations' && floodStationTiles(new URLSearchParams(search));
    if (request?.error) return json(400, { error: request.error });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      if (request) {
        const value = await acquireStations(request);
        return json(200, value, value.stale);
      }
      const { value, stale } = await acquireSections();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'flood_vigilance_unavailable' });
    }
  }

  return {
    name: 'flood-vigilance',
    configureServer({ middlewares }) {
      middlewares.use('/api/flood-vigilance', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/flood-vigilance', handler);
    },
  };
}
