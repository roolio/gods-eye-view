/**
 * Flood vigilance records: Vigicrues river sections. Pure and portable: the
 * server provider imports this module, so it loads no Cesium and no
 * translation catalogs.
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

const COORDINATE_DECIMALS = 4;
const METRES_PER_DEGREE = 111_320;

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
