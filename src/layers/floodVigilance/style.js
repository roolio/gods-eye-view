import { vigilanceLevel } from './records.js';

/**
 * Green sections are the quiet majority (334 of 337 on a calm day): thin and
 * translucent so yellow, orange and red read at a glance.
 */
const SECTION_LINE = Object.freeze({
  1: Object.freeze({ widthPx: 1.5, alpha: 0.45 }),
  2: Object.freeze({ widthPx: 4, alpha: 1 }),
  3: Object.freeze({ widthPx: 5, alpha: 1 }),
  4: Object.freeze({ widthPx: 6, alpha: 1 }),
});

/**
 * @param {1|2|3|4} level
 * @returns {{color: string, widthPx: number, alpha: number}}
 */
export function sectionLineStyle(level) {
  return { color: vigilanceLevel(level).color, ...SECTION_LINE[level] };
}

/** Gauges read as water when fresh and drop to grey past six hours. */
const STATION_POINT = Object.freeze({
  fresh: Object.freeze({ fill: '#38BDF8', outline: '#FFFFFF', pixelSize: 9 }),
  stale: Object.freeze({ fill: '#8A8F98', outline: '#3A3F47', pixelSize: 7 }),
});

/** @param {boolean} stale */
export function stationPointStyle(stale) {
  return stale ? STATION_POINT.stale : STATION_POINT.fresh;
}
