/**
 * Flood vigilance records: Vigicrues river sections and Hub'Eau gauging
 * stations. Pure and portable: the server provider imports this module, so it
 * loads no Cesium and no translation catalogs.
 */
import { msg } from '../../i18n/marker.js';

export const FLOOD_VIGILANCE_LAYER_ID = 'flood-vigilance';

/** Metropolitan France with Corsica: where Vigicrues and Hub'Eau report. */
export const COVERAGE = Object.freeze({
  west: -5.5,
  south: 41,
  east: 10,
  north: 51.5,
});

/** Official Vigicrues palette (vigicrues.gouv.fr styles.css). */
export const VIGILANCE_LEVELS = Object.freeze([
  Object.freeze({
    level: 1,
    color: '#28D761',
    label: msg('Green: no particular vigilance'),
  }),
  Object.freeze({
    level: 2,
    color: '#FFFF00',
    label: msg('Yellow: localised flooding or a rapid rise'),
  }),
  Object.freeze({
    level: 3,
    color: '#FFAA00',
    label: msg('Orange: significant flooding'),
  }),
  Object.freeze({
    level: 4,
    color: '#FF0000',
    label: msg('Red: major flood'),
  }),
]);

/** Section geometry is simplified to this many metres before it is served. */
export const SECTION_SIMPLIFY_TOLERANCE_M = 100;
/** A station with no reading for this long is drawn as out of date. */
export const STATION_STALE_AFTER_MS = 6 * 3600_000;
/** The trend compares the newest height with one about an hour earlier. */
export const TREND_SPAN_MS = 3600_000;
const TREND_MIN_SPAN_MS = 45 * 60_000;
const TREND_MAX_SPAN_MS = 90 * 60_000;
/** Height changes smaller than this over the span read as steady. */
export const TREND_STEADY_MM = 20;

const COORDINATE_DECIMALS = 4;
const METRES_PER_DEGREE = 111_320;
const STATION_CODE = /^[A-Z0-9]{8,12}$/;

/** @param {number} level */
export function vigilanceLevel(level) {
  return VIGILANCE_LEVELS[level - 1] ?? null;
}

function round(value) {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

function validPosition(position) {
  return (
    Array.isArray(position) &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]) &&
    Math.abs(position[0]) <= 180 &&
    Math.abs(position[1]) <= 90
  );
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Douglas-Peucker in metres on a local equirectangular plane, which is exact
 * enough over the length of one river section.
 * @param {Array<[number, number]>} positions [lon, lat] degrees.
 * @param {number} toleranceM
 * @returns {Array<[number, number]>} Kept positions, endpoints included.
 */
export function simplifyLineMeters(positions, toleranceM) {
  if (positions.length <= 2) return positions.slice();
  const meanLat =
    positions.reduce((sum, [, lat]) => sum + lat, 0) / positions.length;
  const kx = METRES_PER_DEGREE * Math.cos((meanLat * Math.PI) / 180);
  const xs = positions.map(([lon]) => lon * kx);
  const ys = positions.map(([, lat]) => lat * METRES_PER_DEGREE);
  const keep = new Uint8Array(positions.length);
  keep[0] = 1;
  keep[positions.length - 1] = 1;
  const stack = [[0, positions.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = -1;
    let worstDistance = toleranceM;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(
        xs[i],
        ys[i],
        xs[first],
        ys[first],
        xs[last],
        ys[last],
      );
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([first, worst], [worst, last]);
  }
  return positions.filter((_, i) => keep[i]);
}

/** One line to a flat [lon0, lat0, lon1, lat1, ...] path, or null. */
function compactLine(line, toleranceM) {
  if (!Array.isArray(line)) return null;
  const positions = line.filter(validPosition);
  if (positions.length < 2) return null;
  const flat = [];
  for (const [lon, lat] of simplifyLineMeters(positions, toleranceM)) {
    const x = round(lon);
    const y = round(lat);
    const n = flat.length;
    if (n && flat[n - 2] === x && flat[n - 1] === y) continue;
    flat.push(x, y);
  }
  return flat.length >= 4 ? flat : null;
}

function sectionLines(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/**
 * @typedef {object} FloodSection
 * @property {string} id Vigicrues `CdEntCru`, e.g. 'AP6'.
 * @property {string} name `lbentcru`.
 * @property {1|2|3|4} level `NivInfViCr`.
 * @property {number[][]} paths Flat lon/lat paths, simplified.
 */

/**
 * Parse the national InfoVigiCru GeoJSON into compact sections.
 * Per-section dates (`dhcentcru`) are reference-data dates, not the bulletin;
 * the bulletin time is the collection's `DtHrInfoVigiCru`.
 * @param {object} payload
 * @param {{toleranceM?: number}} [options]
 * @returns {{publishedAt: number|null, reference: string|null, sections: FloodSection[]}|null}
 *   Null when the payload is not an InfoVigiCru collection.
 */
export function normalizeVigicruesSnapshot(
  payload,
  { toleranceM = SECTION_SIMPLIFY_TOLERANCE_M } = {},
) {
  if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features))
    return null;
  const sections = new Map();
  for (const feature of payload.features) {
    const props = feature?.properties;
    const id = typeof props?.CdEntCru === 'string' ? props.CdEntCru.trim() : '';
    const level = props?.NivInfViCr;
    if (!id || !Number.isInteger(level) || !vigilanceLevel(level)) continue;
    const paths = sectionLines(feature.geometry)
      .map((line) => compactLine(line, toleranceM))
      .filter(Boolean);
    if (!paths.length) continue;
    const name =
      typeof props.lbentcru === 'string' && props.lbentcru.trim()
        ? props.lbentcru.trim()
        : id;
    const previous = sections.get(id);
    if (previous) {
      previous.paths.push(...paths);
      previous.level = Math.max(previous.level, level);
    } else sections.set(id, { id, name, level, paths });
  }
  const publishedAt = Date.parse(payload.DtHrInfoVigiCru);
  return {
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
    reference:
      typeof payload.RefInfoVigiCru === 'string'
        ? payload.RefInfoVigiCru
        : null,
    sections: [...sections.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * @typedef {object} HydroStation
 * @property {string} id `code_station`, e.g. 'F700000103'.
 * @property {string} name
 * @property {string|null} river
 * @property {number} lon
 * @property {number} lat
 */

/**
 * Parse a Hub'Eau `referentiel/stations` JSON page. Stations out of service
 * or without coordinates are dropped.
 * @param {object} payload
 * @returns {HydroStation[]|null} Null when the payload has no `data` array.
 */
export function normalizeHubeauStations(payload) {
  if (!Array.isArray(payload?.data)) return null;
  const stations = [];
  for (const row of payload.data) {
    const id = row?.code_station;
    if (typeof id !== 'string' || !STATION_CODE.test(id)) continue;
    if (row.en_service === false) continue;
    const lon = row.longitude_station;
    const lat = row.latitude_station;
    if (!validPosition([lon, lat])) continue;
    stations.push({
      id,
      name:
        typeof row.libelle_station === 'string' && row.libelle_station.trim()
          ? row.libelle_station.trim()
          : id,
      river:
        typeof row.libelle_cours_eau === 'string' &&
        row.libelle_cours_eau.trim()
          ? row.libelle_cours_eau.trim()
          : null,
      lon,
      lat,
    });
  }
  return stations;
}

/**
 * @typedef {object} HydroReading
 * @property {number} value Metres for H, cubic metres per second for Q.
 * @property {number} observedAt Epoch ms.
 * @property {string|null} method `libelle_methode_obs`, e.g. 'Mesurée'.
 * @property {string|null} qualification `libelle_qualification_obs`.
 */

/** Hub'Eau reports H in millimetres and Q in litres per second. */
export function convertHubeauValue(quantity, raw) {
  if (!Number.isFinite(raw)) return null;
  if (quantity === 'H' || quantity === 'Q') return raw / 1000;
  return null;
}

const label = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * Group `observations_tr` rows by station and quantity, newest first.
 * @param {object[]} rows
 * @returns {Map<string, {H: HydroReading[], Q: HydroReading[]}>}
 */
export function groupHubeauObservations(rows) {
  const byStation = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.code_station;
    const quantity = row?.grandeur_hydro;
    if (typeof id !== 'string' || (quantity !== 'H' && quantity !== 'Q'))
      continue;
    const value = convertHubeauValue(quantity, row.resultat_obs);
    const observedAt = Date.parse(row.date_obs);
    if (value === null || !Number.isFinite(observedAt)) continue;
    let series = byStation.get(id);
    if (!series) byStation.set(id, (series = { H: [], Q: [] }));
    series[quantity].push({
      value,
      observedAt,
      method: label(row.libelle_methode_obs),
      qualification: label(row.libelle_qualification_obs),
    });
  }
  for (const series of byStation.values()) {
    series.H.sort((a, b) => b.observedAt - a.observedAt);
    series.Q.sort((a, b) => b.observedAt - a.observedAt);
  }
  return byStation;
}

/**
 * @typedef {object} HeightTrend
 * @property {'rising'|'falling'|'steady'} direction
 * @property {number} deltaM Newest minus the earlier height.
 * @property {number} spanMs Time between the two readings.
 */

/**
 * Compare the newest height with the reading closest to an hour before it.
 * @param {HydroReading[]} heights Newest first.
 * @returns {HeightTrend|null} Null without a reading 45 to 90 minutes earlier.
 */
export function heightTrend(heights) {
  const [latest] = heights;
  if (!latest) return null;
  let best = null;
  for (const reading of heights) {
    const span = latest.observedAt - reading.observedAt;
    if (span < TREND_MIN_SPAN_MS || span > TREND_MAX_SPAN_MS) continue;
    if (
      !best ||
      Math.abs(span - TREND_SPAN_MS) <
        Math.abs(latest.observedAt - best.observedAt - TREND_SPAN_MS)
    )
      best = reading;
  }
  if (!best) return null;
  const deltaM = latest.value - best.value;
  const steady = TREND_STEADY_MM / 1000;
  return {
    direction:
      deltaM >= steady ? 'rising' : deltaM <= -steady ? 'falling' : 'steady',
    deltaM: Math.round(deltaM * 1000) / 1000,
    spanMs: latest.observedAt - best.observedAt,
  };
}

/**
 * @typedef {object} StationSummary
 * @property {HydroReading|null} height Newest H.
 * @property {HydroReading|null} flow Newest Q.
 * @property {HeightTrend|null} trend
 */

/**
 * Reduce `observations_tr` rows to the newest height, flow and trend per
 * station: all the proxy needs to keep.
 * @param {object[]} rows
 * @returns {Map<string, StationSummary>}
 */
export function summarizeHubeauObservations(rows) {
  const summaries = new Map();
  for (const [id, series] of groupHubeauObservations(rows)) {
    summaries.set(id, {
      height: series.H[0] ?? null,
      flow: series.Q[0] ?? null,
      trend: heightTrend(series.H),
    });
  }
  return summaries;
}

/** @typedef {HydroStation & StationSummary} StationReading */

/**
 * Join stations with their summaries; a station without one has no reading.
 * @param {HydroStation[]} stations
 * @param {Map<string, StationSummary>} summaries
 * @returns {StationReading[]}
 */
export function joinStationReadings(stations, summaries) {
  return stations.map((station) => ({
    ...station,
    height: summaries.get(station.id)?.height ?? null,
    flow: summaries.get(station.id)?.flow ?? null,
    trend: summaries.get(station.id)?.trend ?? null,
  }));
}

/** Newest observation time of a station, or null when it has none. */
export function stationObservedAt(station) {
  const times = [station?.height?.observedAt, station?.flow?.observedAt].filter(
    Number.isFinite,
  );
  return times.length ? Math.max(...times) : null;
}

/** True when a station has no reading in the last six hours. */
export function stationIsStale(station, nowMs) {
  const at = stationObservedAt(station);
  return at === null || nowMs - at > STATION_STALE_AFTER_MS;
}
