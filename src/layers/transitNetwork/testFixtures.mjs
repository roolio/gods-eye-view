import { toLonLatH } from '../../geo/ellipsoid.js';
import { CAPABILITIES } from '../../render/contract/index.js';
import { createSceneHost } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';
import { STATION_SET_ID, TRACK_SET_PREFIX } from './scene.js';
import { createBundledTransitNetworkSource } from './source.js';

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

/**
 * A scene host with the stub renderer bound, the eye looking straight down
 * on (`lon`, `lat`) from `heightM`. Surface heights answer from
 * `surfaceHeight` (null for a miss), each call logged in `sampleCalls`;
 * terrain heights answer from `terrainHeight`. Without
 * `sampleHeightSupported` the renderer lacks the `sampleHeight` capability
 * and answers no surface height, as the Cesium renderer without depth
 * textures does.
 */
export function stubViewer({
  lon = 2.347,
  lat = 48.858,
  heightM = 3000,
  globeShow = true,
  terrainHeight = () => null,
  surfaceHeight = () => null,
  sampleHeightSupported = true,
} = {}) {
  const capabilities = new Set(CAPABILITIES);
  if (!sampleHeightSupported) capabilities.delete('sampleHeight');
  const renderer = createStubRenderer({
    capabilities,
    viewport: { width: 1200, height: 800 },
  });
  const { host: viewer, release } = createSceneHost(renderer, {
    container: {},
  });
  renderer.globe.setGlobeVisible(globeShow);

  const sampleCalls = [];
  renderer.query.sampleHeightNow = (point, options = {}) => {
    const against = options.against ?? 'surface';
    if (against === 'terrain') return terrainHeight(point) ?? null;
    if (!capabilities.has('sampleHeight')) return null;
    sampleCalls.push({ lon: point.lon, lat: point.lat, against });
    return surfaceHeight(point) ?? null;
  };

  // Live subscriptions to the frame's preRender and the camera's moveEnd.
  const listeners = { preRender: 0, moveEnd: 0 };
  const counted = (port, event) => {
    const on = port.on.bind(port);
    port.on = (name, cb, options) => {
      const off = on(name, cb, options);
      if (name !== event) return off;
      listeners[event]++;
      let live = true;
      return () => {
        if (live) listeners[event]--;
        live = false;
        off();
      };
    };
  };
  counted(renderer.frame, 'preRender');
  counted(renderer.camera, 'moveEnd');

  function lookDownFrom(lonDeg, latDeg, height) {
    renderer.camera.setView({
      destination: { lon: lonDeg, lat: latDeg, height },
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }
  lookDownFrom(lon, lat, heightM);

  const items = (id) => [
    ...(renderer.testing.setRecord(id)?.items.values() ?? []),
  ];
  return {
    viewer,
    renderer,
    sampleCalls,
    listeners,
    lookDownFrom,
    release,
    pose: () => renderer.camera.pose(),
    /** The station dots as drawn, in the order they were first drawn. */
    dots: () => items(STATION_SET_ID),
    dot: (id) => renderer.testing.setRecord(STATION_SET_ID)?.items.get(id),
    /** The ids of the live track sets, in the order they were made. */
    trackSets: () =>
      renderer.testing
        .sets()
        .filter((id) => id.startsWith(`${TRACK_SET_PREFIX}:`)),
    trackSet: (id) => renderer.testing.setRecord(id),
    trackItems: (id) => items(id),
  };
}

/** Metres above the ellipsoid of an ECEF position or a draw item's `pos`. */
export function heightOf(position) {
  const height =
    'lon' in position ? position.height : toLonLatH(position).height;
  return Number(height.toFixed(3));
}
