import * as Cesium from 'cesium';
import { createStationOverlayEntry } from './labels.js';
import {
  STATION_FILL,
  stationOutlineColor,
  stationPixelSize,
  trackWidthPx,
} from './style.js';

export const HEIGHT_SAMPLES_PER_SWEEP = 24;
const HEIGHT_RETRY_MS = 1000;
const STATION_ANCHOR_LIFT_M = 2;
const STATION_DOT_MAX_DISTANCE_M = 60000;
const RESAMPLE_RADIUS_M = 25000;

/**
 * @typedef {object} StationRecord
 * @property {import('./source.js').TransitStation} station
 * @property {Cesium.Cartesian3} position Shared by the dot and its label.
 * @property {Cesium.PointPrimitive} point
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
 * @property {(camera: Cesium.Camera, now: number) => {pendingVisible: boolean}} sweep
 *   Annotates every record, then samples at most HEIGHT_SAMPLES_PER_SWEEP
 *   heights, nearest visible first.
 * @property {(classificationType: Cesium.ClassificationType) => void} setSurface
 *   Map stack changed: reclassify the tracks in place and forget every height.
 * @property {() => number} rearmNearby Tile loads finished: resample nearby
 *   resolved stations once. Returns how many were armed.
 * @property {() => {pendingHeights: number, samplingUnsupported: boolean}} stats
 * @property {() => void} dispose Idempotent.
 */

function isPhotorealSurface(scene, classificationType) {
  if (classificationType === Cesium.ClassificationType.CESIUM_3D_TILE)
    return true;
  if (classificationType === Cesium.ClassificationType.TERRAIN) return false;
  return scene.globe?.show === false;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {import('./source.js').TransitNetwork} network
 * @param {{classificationType: Cesium.ClassificationType}} options
 * @returns {TransitScene}
 */
export function createTransitScene(viewer, network, { classificationType }) {
  const scene = viewer.scene;
  const pickExclusionId = Object.freeze({ layer: 'transit-network' });
  const exclude = [pickExclusionId];

  const tracks = scene.groundPrimitives.add(new Cesium.PrimitiveCollection());
  const trackPrimitives = [];
  // Add order is draw order: level 0 (narrowest, best rank) goes last, on top.
  for (let level = network.strandsByLevel.length - 1; level >= 0; level--) {
    const instances = [];
    for (const strand of network.strandsByLevel[level]) {
      const color = Cesium.Color.fromCssColorString(strand.line.color);
      const width = trackWidthPx(strand.line.mode, level);
      for (const path of strand.paths) {
        instances.push(
          new Cesium.GeometryInstance({
            id: pickExclusionId,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(path),
              width,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
            },
          }),
        );
      }
    }
    if (instances.length === 0) continue;
    trackPrimitives.push(
      tracks.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType,
        }),
      ),
    );
  }

  let photoreal = isPhotorealSurface(scene, classificationType);
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const fill = Cesium.Color.fromCssColorString(STATION_FILL);
  const displayCondition = new Cesium.DistanceDisplayCondition(
    0,
    STATION_DOT_MAX_DISTANCE_M,
  );
  const scale = new Cesium.NearFarScalar(1000, 1, 40000, 0.5);
  /** @type {StationRecord[]} */
  const records = network.stations.map((station) => {
    const position = Cesium.Cartesian3.fromDegrees(
      station.lon,
      station.lat,
      STATION_ANCHOR_LIFT_M,
    );
    const point = points.add({
      id: pickExclusionId,
      position,
      show: !photoreal,
      pixelSize: stationPixelSize(station.lines.length),
      color: fill,
      outlineColor: Cesium.Color.fromCssColorString(
        stationOutlineColor(station),
      ),
      outlineWidth: 2,
      distanceDisplayCondition: displayCondition,
      scaleByDistance: scale,
    });
    return {
      station,
      position,
      point,
      entry: createStationOverlayEntry(station, position),
      resolved: false,
      resample: false,
      retryAt: 0,
      inView: false,
      visible: false,
      distanceM: Infinity,
    };
  });

  const carto = new Cesium.Cartographic();
  const sphere = new Cesium.BoundingSphere(new Cesium.Cartesian3(), 1);
  let samplingUnsupported = false;
  let disposed = false;

  function sampleSurfaceHeight(record) {
    Cesium.Cartographic.fromDegrees(
      record.station.lon,
      record.station.lat,
      0,
      carto,
    );
    if (!photoreal) {
      const height = scene.globe?.getHeight?.(carto);
      if (Number.isFinite(height)) return height;
    }
    if (!scene.sampleHeightSupported) return undefined;
    try {
      return scene.sampleHeight(carto, exclude);
    } catch {
      return undefined;
    }
  }

  function placeAt(record, heightM) {
    Cesium.Cartesian3.fromDegrees(
      record.station.lon,
      record.station.lat,
      heightM,
      Cesium.Ellipsoid.WGS84,
      record.position,
    );
    record.point.position = record.position;
  }

  const needsHeight = (record) => !record.resolved || record.resample;

  return {
    records,

    sweep(camera, now) {
      const cameraPosition = camera.positionWC;
      const culling = camera.frustum.computeCullingVolume(
        cameraPosition,
        camera.directionWC,
        camera.upWC,
      );
      for (const record of records) {
        record.distanceM = Cesium.Cartesian3.distance(
          cameraPosition,
          record.position,
        );
        Cesium.Cartesian3.clone(record.position, sphere.center);
        record.inView =
          culling.computeVisibility(sphere) !== Cesium.Intersect.OUTSIDE;
      }

      const eligible = (record) =>
        record.inView &&
        record.distanceM <= STATION_DOT_MAX_DISTANCE_M &&
        needsHeight(record);
      if (!samplingUnsupported) {
        if (photoreal && !scene.sampleHeightSupported) {
          samplingUnsupported = true;
        } else {
          const due = records
            .filter((record) => eligible(record) && record.retryAt <= now)
            .sort((a, b) => a.distanceM - b.distanceM)
            .slice(0, HEIGHT_SAMPLES_PER_SWEEP);
          for (const record of due) {
            const height = sampleSurfaceHeight(record);
            record.resample = false;
            if (Number.isFinite(height)) {
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
        record.point.show = !photoreal || record.resolved;
        record.visible = record.inView && record.point.show;
        if (!samplingUnsupported && eligible(record)) pendingVisible = true;
      }
      return { pendingVisible };
    },

    setSurface(type) {
      for (const primitive of trackPrimitives)
        primitive.classificationType = type;
      photoreal = isPhotorealSurface(scene, type);
      samplingUnsupported = false;
      for (const record of records) {
        record.resolved = false;
        record.resample = false;
        record.retryAt = 0;
        record.visible = false;
        record.point.show = !photoreal;
      }
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
      for (const [collection, child] of [
        [scene.groundPrimitives, tracks],
        [scene.primitives, points],
      ]) {
        if (viewer.isDestroyed?.()) continue;
        if (!collection.isDestroyed?.()) collection.remove(child);
        else if (!child.isDestroyed?.()) child.destroy();
      }
      records.length = 0;
    },
  };
}
