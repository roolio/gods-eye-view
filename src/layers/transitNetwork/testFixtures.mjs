import * as Cesium from 'cesium';
import { createBundledTransitNetworkSource } from './source.js';

// Node has no WebGL context; GroundPolylinePrimitive validates its 1 px
// render-state line width against these limits at construction.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 1;

export const LINES = {
  B: {
    line: 'C01743',
    code: 'B',
    name: 'RER B',
    mode: 'rer',
    color: '#5091CB',
    rank: 1,
  },
  D: {
    line: 'C01728',
    code: 'D',
    name: 'RER D',
    mode: 'rer',
    color: '#008B5B',
    rank: 3,
  },
  M1: {
    line: 'C01371',
    code: '1',
    name: 'Métro 1',
    mode: 'metro',
    color: '#FFBE00',
    rank: 14,
  },
};

export function lineFeature(line, level, coordinates) {
  return {
    type: 'Feature',
    id: `${line.line}:${level}`,
    properties: { kind: 'line', ...line, level },
    geometry: { type: 'MultiLineString', coordinates },
  };
}

export function stationFeature(id, name, lineIds, coordinates) {
  return {
    type: 'Feature',
    id,
    properties: { kind: 'station', name, lineIds },
    geometry: { type: 'Point', coordinates },
  };
}

export const collection = (features) => ({
  type: 'FeatureCollection',
  features,
});

export function sourceServing(json) {
  const source = createBundledTransitNetworkSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => structuredClone(json),
    }),
  });
  let fetches = 0;
  return {
    label: source.label,
    get fetches() {
      return fetches;
    },
    fetch(signal) {
      fetches++;
      return source.fetch(signal);
    },
  };
}

export function parseNetwork(json) {
  return sourceServing(json).fetch();
}

export function parisFixture() {
  return collection([
    lineFeature(LINES.B, 0, [
      [
        [2.347, 48.858],
        [2.355, 48.88],
      ],
    ]),
    lineFeature(LINES.D, 0, [
      [
        [2.37, 48.84],
        [2.347, 48.858],
      ],
    ]),
    lineFeature(LINES.D, 1, [
      [
        [2.347, 48.858],
        [2.355, 48.88],
      ],
    ]),
    lineFeature(LINES.M1, 0, [
      [
        [2.33, 48.86],
        [2.36, 48.855],
      ],
    ]),
    stationFeature(
      'gare:1',
      'Châtelet',
      ['C01743', 'C01728', 'C01371'],
      [2.347, 48.858],
    ),
    stationFeature(
      'gare:2',
      'Gare du Nord',
      ['C01743', 'C01728'],
      [2.355, 48.88],
    ),
    stationFeature('gare:3', 'Gare de Lyon', ['C01728'], [2.373, 48.844]),
  ]);
}

export function fakeViewer({
  lon = 2.347,
  lat = 48.858,
  heightM = 3000,
  globeShow = true,
  getHeight = () => undefined,
  sampleHeight = () => undefined,
  sampleHeightSupported = true,
} = {}) {
  const sampleCalls = [];
  const renders = { count: 0 };
  const camera = {
    positionWC: new Cesium.Cartesian3(),
    directionWC: new Cesium.Cartesian3(),
    upWC: new Cesium.Cartesian3(),
    positionCartographic: new Cesium.Cartographic(),
    frustum: new Cesium.PerspectiveFrustum({
      fov: Cesium.Math.toRadians(60),
      aspectRatio: 1.5,
      near: 1,
      far: 1e8,
    }),
    moveEnd: new Cesium.Event(),
  };
  function lookDownFrom(lonDeg, latDeg, height) {
    Cesium.Cartesian3.fromDegrees(
      lonDeg,
      latDeg,
      height,
      Cesium.Ellipsoid.WGS84,
      camera.positionWC,
    );
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(camera.positionWC);
    const up = Cesium.Matrix4.getColumn(frame, 2, new Cesium.Cartesian4());
    const north = Cesium.Matrix4.getColumn(frame, 1, new Cesium.Cartesian4());
    Cesium.Cartesian3.negate(
      Cesium.Cartesian3.fromCartesian4(up),
      camera.directionWC,
    );
    Cesium.Cartesian3.fromCartesian4(north, camera.upWC);
    Cesium.Cartographic.fromDegrees(
      lonDeg,
      latDeg,
      height,
      camera.positionCartographic,
    );
  }
  lookDownFrom(lon, lat, heightM);
  const scene = {
    groundPrimitives: new Cesium.PrimitiveCollection(),
    primitives: new Cesium.PrimitiveCollection(),
    globe: {
      show: globeShow,
      tilesLoaded: false,
      getHeight: (carto) => getHeight(carto),
    },
    sampleHeightSupported,
    sampleHeight(carto, exclude) {
      sampleCalls.push({
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
        exclude,
      });
      return sampleHeight(carto);
    },
    preRender: new Cesium.Event(),
    requestRender() {
      renders.count++;
    },
  };
  return { scene, camera, sampleCalls, renders, lookDownFrom };
}

export function heightOf(position) {
  return Number(Cesium.Cartographic.fromCartesian(position).height.toFixed(3));
}
