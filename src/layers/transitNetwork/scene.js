import { fromDegrees, fromDegreesInto } from '../../geo/ellipsoid.js';
import { frustumPlanes, sphereOutside } from '../../geo/frustum.js';
import { distance } from '../../geo/vector.js';
import { heightsOf } from '../../queries/heights.js';
import { drawOf, findGlobe } from '../../render/rendererOf.js';
import { createStationOverlayEntry } from './labels.js';
import {
  STATION_FILL,
  stationOutlineColor,
  stationPixelSize,
  trackWidthPx,
} from './style.js';

export const HEIGHT_SAMPLES_PER_SWEEP = 24;
export const TRACK_SET_PREFIX = 'transit-network:tracks';
export const STATION_SET_ID = 'transit-network:stations';
const HEIGHT_RETRY_MS = 1000;
const STATION_ANCHOR_LIFT_M = 2;
const STATION_DOT_MAX_DISTANCE_M = 60000;
const RESAMPLE_RADIUS_M = 25000;
const STATION_SCALE = Object.freeze({
  near: 1000,
  nearValue: 1,
  far: 40000,
  farValue: 0.5,
});
const STATION_DISPLAY_RANGE = Object.freeze([0, STATION_DOT_MAX_DISTANCE_M]);

/** @typedef {'tiles'|'terrain'|'both'} ClampTarget */

/**
 * @typedef {object} StationRecord
 * @property {import('./source.js').TransitStation} station
 * @property {{x: number, y: number, z: number}} position ECEF anchor shared
 *   by the dot and its label, moved in place.
 * @property {import('../../render/contract/draw').PointItem} point The dot's
 *   draw-set item; re-sent when its show or height changes.
 * @property {object} entry
 * @property {boolean} resolved Surface height known for the current surface.
 * @property {boolean} resample One resample armed by a tile-load completion.
 * @property {number} retryAt Earliest next sample after a miss.
 * @property {boolean} inView
 * @property {boolean} visible
 * @property {number} distanceM
 */

/**
 * @typedef {object} TransitScene
 * @property {StationRecord[]} records
 * @property {(pose: import('../../render/contract/camera').CameraPose, now: number) => {pendingVisible: boolean}} sweep
 *   Annotates every record, then samples at most HEIGHT_SAMPLES_PER_SWEEP
 *   heights, nearest visible first.
 * @property {(clampTo: ClampTarget) => void} setSurface
 *   Map stack changed: drape the tracks on the new surface and forget every
 *   height.
 * @property {() => number} rearmNearby Tile loads finished: resample nearby
 *   resolved stations once. Returns how many were armed.
 * @property {() => {pendingHeights: number, samplingUnsupported: boolean}} stats
 * @property {() => void} dispose Idempotent.
 */

/**
 * Whether stations stand on the photoreal tiles: their dots then wait for a
 * sampled height, since an ellipsoid anchor would sink under the buildings.
 * @param {object} viewer
 * @param {ClampTarget} clampTo
 */
function isPhotorealSurface(viewer, clampTo) {
  if (clampTo === 'tiles') return true;
  if (clampTo === 'terrain') return false;
  return findGlobe(viewer)?.isGlobeVisible?.() === false;
}

/**
 * @param {object} viewer The scene object the renderer is bound to.
 * @param {import('./source.js').TransitNetwork} network
 * @param {{clampTo: ClampTarget}} options
 * @returns {TransitScene}
 */
export function createTransitScene(viewer, network, { clampTo }) {
  const draw = drawOf(viewer);
  const heights = heightsOf(viewer);

  // Made order is draw order among draped sets: level 0 (narrowest, best
  // rank) is made last, so it draws on top.
  const trackSets = [];
  for (let level = network.strandsByLevel.length - 1; level >= 0; level--) {
    const items = [];
    for (const strand of network.strandsByLevel[level]) {
      const widthPx = trackWidthPx(strand.line.mode, level);
      for (const path of strand.paths) {
        const positions = [];
        for (let i = 0; i + 1 < path.length; i += 2)
          positions.push(fromDegrees(path[i], path[i + 1], 0));
        items.push({
          id: `${strand.line.id}:${level}:${items.length}`,
          positions,
          widthPx,
          mode: 'draped',
          style: { kind: 'solid', color: strand.line.color },
        });
      }
    }
    if (items.length === 0) continue;
    const set = draw.lines({
      id: `${TRACK_SET_PREFIX}:${level}`,
      clampTo,
      pickable: false,
    });
    set.set(items);
    trackSets.push(set);
  }

  let photoreal = isPhotorealSurface(viewer, clampTo);
  const points = draw.points({ id: STATION_SET_ID, pickable: false });
  /** @type {StationRecord[]} */
  const records = network.stations.map((station) => {
    const position = fromDegrees(
      station.lon,
      station.lat,
      STATION_ANCHOR_LIFT_M,
    );
    return {
      station,
      position,
      point: {
        id: station.id,
        pos: { ...position },
        show: !photoreal,
        pixelSize: stationPixelSize(station.lines.length),
        color: STATION_FILL,
        outlineColor: stationOutlineColor(station),
        outlineWidth: 2,
        displayRange: STATION_DISPLAY_RANGE,
        scaleByDistance: STATION_SCALE,
      },
      entry: createStationOverlayEntry(station, position),
      resolved: false,
      resample: false,
      retryAt: 0,
      inView: false,
      visible: false,
      distanceM: Infinity,
    };
  });
  points.set(records.map((record) => record.point));

  const at = { lon: 0, lat: 0 };
  const TERRAIN = Object.freeze({ against: 'terrain' });
  let samplingUnsupported = false;
  let disposed = false;
  /** Dots whose item changed this sweep, re-sent in one upsert. */
  const changed = new Set();

  function sampleSurfaceHeight(record) {
    at.lon = record.station.lon;
    at.lat = record.station.lat;
    if (!photoreal) {
      const height = heights.now(at, TERRAIN);
      if (height !== null) return height;
    }
    if (!heights.supported().surface) return null;
    return heights.now(at);
  }

  function placeAt(record, heightM) {
    fromDegreesInto(
      record.station.lon,
      record.station.lat,
      heightM,
      record.position,
    );
    record.point.pos = { ...record.position };
    changed.add(record);
  }

  function showDot(record, show) {
    if (record.point.show === show) return;
    record.point.show = show;
    changed.add(record);
  }

  function flush() {
    if (changed.size === 0 || disposed) return;
    points.upsert([...changed].map((record) => record.point));
    changed.clear();
  }

  const needsHeight = (record) => !record.resolved || record.resample;

  return {
    records,

    sweep(pose, now) {
      const eye = pose.position;
      const planes = frustumPlanes(pose);
      for (const record of records) {
        record.distanceM = distance(eye, record.position);
        record.inView = !sphereOutside(planes, record.position, 1);
      }

      const eligible = (record) =>
        record.inView &&
        record.distanceM <= STATION_DOT_MAX_DISTANCE_M &&
        needsHeight(record);
      if (!samplingUnsupported) {
        if (photoreal && !heights.supported().surface) {
          samplingUnsupported = true;
        } else {
          const due = records
            .filter((record) => eligible(record) && record.retryAt <= now)
            .sort((a, b) => a.distanceM - b.distanceM)
            .slice(0, HEIGHT_SAMPLES_PER_SWEEP);
          for (const record of due) {
            const height = sampleSurfaceHeight(record);
            record.resample = false;
            if (height !== null) {
              placeAt(record, height + STATION_ANCHOR_LIFT_M);
              record.resolved = true;
            } else {
              record.retryAt = now + HEIGHT_RETRY_MS;
            }
          }
        }
      }

      let pendingVisible = false;
      for (const record of records) {
        showDot(record, !photoreal || record.resolved);
        record.visible = record.inView && record.point.show;
        if (!samplingUnsupported && eligible(record)) pendingVisible = true;
      }
      flush();
      return { pendingVisible };
    },

    setSurface(next) {
      for (const set of trackSets) set.setOptions({ clampTo: next });
      photoreal = isPhotorealSurface(viewer, next);
      samplingUnsupported = false;
      for (const record of records) {
        record.resolved = false;
        record.resample = false;
        record.retryAt = 0;
        record.visible = false;
        showDot(record, !photoreal);
      }
      flush();
    },

    rearmNearby() {
      let armed = 0;
      for (const record of records) {
        if (
          record.resolved &&
          record.inView &&
          record.distanceM <= RESAMPLE_RADIUS_M
        ) {
          record.resample = true;
          armed++;
        }
      }
      return armed;
    },

    stats() {
      return {
        pendingHeights: records.filter(needsHeight).length,
        samplingUnsupported,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      changed.clear();
      for (const set of trackSets) set.dispose();
      points.dispose();
      records.length = 0;
    },
  };
}
