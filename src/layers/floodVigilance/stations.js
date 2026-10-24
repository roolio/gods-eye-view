import * as Cesium from 'cesium';
import { formatNumber } from '../../i18n/index.js';
import { FLOOD_VIGILANCE_LAYER_ID, stationIsStale } from './records.js';
import { stationPointStyle } from './style.js';

export const STATION_PICK_PREFIX = `${FLOOD_VIGILANCE_LAYER_ID}:station:`;
export const STATION_LABEL_SOURCE_ID = 'flood-vigilance-stations';
/** Stations show only below this camera height; above it, sections alone. */
export const STATIONS_MAX_HEIGHT_M = 150_000;
/** Height labels show only below this camera height. */
export const STATION_LABELS_MAX_HEIGHT_M = 60_000;
export const STATION_LABEL_COHORT_LIMIT = 32;
/** Half the query box around the view centre: 3° by 2°, at most 12 tiles. */
const QUERY_HALF_LON = 1.5;
const QUERY_HALF_LAT = 1;
const TREND_ARROWS = Object.freeze({
  rising: '↑',
  falling: '↓',
  steady: '→',
});

/**
 * The box of stations to request around the view centre.
 * @param {{lon: number, lat: number}} centre Degrees.
 */
export function stationQueryBox({ lon, lat }) {
  return {
    west: Math.max(-180, lon - QUERY_HALF_LON),
    south: Math.max(-90, lat - QUERY_HALF_LAT),
    east: Math.min(180, lon + QUERY_HALF_LON),
    north: Math.min(90, lat + QUERY_HALF_LAT),
  };
}

/** Views that snap to the same whole-degree tiles share one key. */
export function stationQueryKey(box) {
  return [
    Math.floor(box.west),
    Math.floor(box.south),
    Math.ceil(box.east),
    Math.ceil(box.north),
  ].join(',');
}

/** "0.98 m ↑": the newest height and its hourly trend. */
export function stationLabelTitle(station) {
  const value = formatNumber(station.height.value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const arrow = TREND_ARROWS[station.trend?.direction] ?? '';
  return arrow ? `${value} m ${arrow}` : `${value} m`;
}

/** Rising heights win the label budget, then falling, then the largest change. */
function labelPriority(station) {
  const direction = station.trend?.direction;
  const base = direction === 'rising' ? 3 : direction === 'falling' ? 2 : 1;
  const changeMm = Math.round(Math.abs(station.trend?.deltaM ?? 0) * 1000);
  return base * 1_000_000 + Math.min(999_999, changeMm);
}

/**
 * Dots for the gauging stations of the current view, and their height labels.
 * @param {Cesium.Viewer} viewer
 * @param {import('./records.js').StationReading[]} stations
 * @param {number} nowMs
 */
export function createStationScene(viewer, stations, nowMs) {
  const scene = viewer.scene;
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const carto = new Cesium.Cartographic();
  const records = stations.map((station) => {
    Cesium.Cartographic.fromDegrees(station.lon, station.lat, 0, carto);
    const ground = scene.globe?.show ? scene.globe.getHeight?.(carto) : null;
    const position = Cesium.Cartesian3.fromDegrees(
      station.lon,
      station.lat,
      (Number.isFinite(ground) ? ground : 0) + 2,
    );
    const stale = stationIsStale(station, nowMs);
    const style = stationPointStyle(stale);
    points.add({
      id: `${STATION_PICK_PREFIX}${station.id}`,
      position,
      pixelSize: style.pixelSize,
      color: Cesium.Color.fromCssColorString(style.fill),
      outlineColor: Cesium.Color.fromCssColorString(style.outline),
      outlineWidth: 2,
      // Gauges sit on river banks, often below photoreal or terrain surfaces.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    return { station, position, stale };
  });
  let disposed = false;
  return {
    records,
    /** Height labels for fresh stations, best first, capped. */
    labelEntries() {
      return records
        .filter(({ station, stale }) => !stale && station.height)
        .sort(
          (a, b) =>
            labelPriority(b.station) - labelPriority(a.station) ||
            a.station.id.localeCompare(b.station.id),
        )
        .slice(0, STATION_LABEL_COHORT_LIMIT)
        .map(({ station, position }) => ({
          id: `flood-vigilance-station:${station.id}`,
          position,
          variant: 'label',
          title: stationLabelTitle(station),
          accent: stationPointStyle(false).fill,
          priority: labelPriority(station),
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 10,
          verticalOnly: true,
          placement: 'above',
        }));
    },
    setVisible(visible) {
      points.show = visible;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (viewer.isDestroyed?.()) return;
      if (!scene.primitives.isDestroyed?.()) scene.primitives.remove(points);
      else if (!points.isDestroyed?.()) points.destroy();
    },
  };
}
