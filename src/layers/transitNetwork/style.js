/** @type {Readonly<Record<import('./source.js').TransitMode, number>>} */
export const TRACK_BASE_WIDTH_PX = Object.freeze({
  rer: 4.5,
  train: 4,
  metro: 3,
  tram: 2.5,
  shuttle: 2.5,
});

const WIDEST_BASE_WIDTH_PX = Math.max(...Object.values(TRACK_BASE_WIDTH_PX));
const CASING_STEP_PX = 3;

/**
 * @param {import('./source.js').TransitMode} mode
 * @param {import('./source.js').CasingLevel} level
 * @returns {number} CSS pixels.
 */
export function trackWidthPx(mode, level) {
  if (level === 0) return TRACK_BASE_WIDTH_PX[mode];
  return WIDEST_BASE_WIDTH_PX + CASING_STEP_PX * level;
}

/**
 * @param {number} lineCount
 * @returns {number} Dot diameter in CSS pixels.
 */
export function stationPixelSize(lineCount) {
  if (lineCount >= 4) return 10;
  if (lineCount >= 2) return 8;
  return 6;
}

export const STATION_FILL = '#FFFFFF';
export const INTERCHANGE_OUTLINE = '#1A1A1A';

/**
 * Metro-map convention: a single-line stop is ringed in its line colour, an
 * interchange in near-black.
 * @param {import('./source.js').TransitStation} station
 * @returns {string}
 */
export function stationOutlineColor(station) {
  return station.lines.length === 1
    ? station.lines[0].color
    : INTERCHANGE_OUTLINE;
}
