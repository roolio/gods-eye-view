import { dot } from '../../geo/vector.js';
import { t } from '../../i18n/index.js';
import { cameraOf, findFrame, findGlobe } from '../../render/rendererOf.js';
import {
  cableClassificationTypeForScene,
  cableClassificationTypeForStack,
  createCableReferenceSweepGate,
} from '../submarineCables/index.js';
import {
  createStationLabelPublisher,
  selectStationLabelWinners,
} from './labels.js';
import { createTransitScene } from './scene.js';

export const TRANSIT_NETWORK_LAYER_ID = 'transit-network';

const PROBE_INTERVAL_MS = 250;
const RETRY_FRAME_MS = 1000;
const COS_ONE_DEGREE = Math.cos(Math.PI / 180);

/** The surface in view (the globe's tiles, or the photoreal ones) has loaded. */
const surfaceTilesLoaded = (viewer) =>
  findGlobe(viewer)?.isSettled('surface') === true;

/**
 * Static Île-de-France rail network: 46 lines in official colours, one dot
 * per station, names near the ground.
 * @param {object} deps
 * @param {{label: string, fetch(signal?: AbortSignal): Promise<import('./source.js').TransitNetwork>}} deps.source
 * @param {{setVisible: Function, setEntries: Function, clearSource: Function}} deps.overlayHost
 * @param {EventTarget|null} [deps.mapStackEventTarget] window in the app.
 * @param {() => number} [deps.now] Monotonic clock.
 * @returns {object} Catalog layer.
 */
export function createTransitNetworkLayer({
  source,
  overlayHost,
  mapStackEventTarget = null,
  now = () => performance.now(),
}) {
  if (!source?.fetch || !source.label)
    throw new TypeError(
      'A transit network source with a label and fetch(signal) is required',
    );

  let viewer = null;
  let enabled = false;
  /** @type {import('./source.js').TransitNetwork|null} */
  let network = null;
  /** @type {import('./scene.js').TransitScene|null} */
  let scene = null;
  let generation = 0;
  /** @type {{generation: number, abort: AbortController, promise: Promise<void>}|null} */
  let pending = null;
  let error = null;
  let lastUpdate = null;
  /** @type {'tiles'|'terrain'|'both'} What the tracks drape on. */
  let clampTo = 'both';
  const gate = createCableReferenceSweepGate({
    now,
    probeIntervalMs: PROBE_INTERVAL_MS,
    motionEpsilonM: 25,
  });
  const labels = createStationLabelPublisher({ host: overlayHost });
  const sweptDirection = { x: 0, y: 0, z: 0 };
  let hasSweptDirection = false;
  let lastProbeAt = -Infinity;
  let tilesWereLoaded = false;
  let retryTimer = null;
  let removePreRender = null;
  let removeMoveEnd = null;
  let onStackChanged = null;

  const requestRender = () => {
    if (viewer) findFrame(viewer)?.requestRender('transit-network');
  };

  function mount() {
    if (scene || !enabled || !viewer || !network) return;
    scene = createTransitScene(viewer, network, { clampTo });
    gate.markDirty();
    requestRender();
  }

  function unmount() {
    scene?.dispose();
    scene = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    hasSweptDirection = false;
    gate.reset();
  }

  function load() {
    if (!enabled || !viewer) return Promise.resolve();
    if (network) {
      mount();
      return Promise.resolve();
    }
    if (pending) return pending.promise;
    const mine = ++generation;
    const abort = new AbortController();
    const promise = (async () => {
      try {
        const fetched = await source.fetch(abort.signal);
        if (mine !== generation || !enabled || !viewer) return;
        network = fetched;
        error = null;
        lastUpdate = Date.now();
        mount();
      } catch (failure) {
        if (mine === generation && failure?.name !== 'AbortError') {
          error = failure?.message || String(failure);
          console.warn('[Data:transit-network]', error, failure);
        }
      } finally {
        if (pending?.generation === mine) pending = null;
      }
    })();
    pending = { generation: mine, abort, promise };
    return promise;
  }

  function scheduleRetryFrame() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!scene) return;
      gate.markDirty();
      requestRender();
    }, RETRY_FRAME_MS);
  }

  function headingChanged(direction) {
    return hasSweptDirection && dot(direction, sweptDirection) < COS_ONE_DEGREE;
  }

  function probe(pose, time) {
    if (time - lastProbeAt < PROBE_INTERVAL_MS) return;
    lastProbeAt = time;
    if (headingChanged(pose.direction)) gate.markDirty();
    const loaded = surfaceTilesLoaded(viewer);
    if (loaded && !tilesWereLoaded && scene.rearmNearby() > 0) gate.markDirty();
    tilesWereLoaded = loaded;
  }

  function disable() {
    enabled = false;
    generation++;
    pending?.abort.abort();
    pending = null;
    labels.hide();
    unmount();
  }

  function sweep() {
    if (!enabled || !scene) return;
    const pose = cameraOf(viewer).pose();
    const time = now();
    probe(pose, time);
    if (!gate.shouldRun({ positionWC: pose.position })) return;
    sweptDirection.x = pose.direction.x;
    sweptDirection.y = pose.direction.y;
    sweptDirection.z = pose.direction.z;
    hasSweptDirection = true;
    const { pendingVisible } = scene.sweep(pose, time);
    labels.publish(selectStationLabelWinners(scene.records, pose.height));
    if (pendingVisible) scheduleRetryFrame();
  }

  return {
    id: TRANSIT_NETWORK_LAYER_ID,
    name: 'Île-de-France Rail Network',
    icon: '🚇',
    source: source.label,
    updateInterval: 0,
    statsRefreshInterval: 500,

    init(v) {
      viewer = v;
      clampTo = cableClassificationTypeForScene(v);
      if (!onStackChanged && mapStackEventTarget?.addEventListener) {
        onStackChanged = (event) => {
          clampTo = event?.detail?.activeId
            ? cableClassificationTypeForStack(event.detail.activeId)
            : cableClassificationTypeForScene(viewer);
          if (!scene) return;
          scene.setSurface(clampTo);
          tilesWereLoaded = false;
          gate.markDirty();
          requestRender();
        };
        mapStackEventTarget.addEventListener(
          'gev:map-stack-changed',
          onStackChanged,
        );
      }
      removePreRender ??= findFrame(v)?.on('preRender', sweep) ?? null;
      removeMoveEnd ??= cameraOf(v).on('moveEnd', () => {
        if (!enabled) return;
        gate.markDirty();
        requestRender();
      });
    },

    enable(v) {
      viewer = v || viewer;
      enabled = true;
      labels.show();
      gate.markDirty();
      requestRender();
      return load();
    },

    disable,

    update() {
      return load();
    },

    destroy() {
      disable();
      removePreRender?.();
      removePreRender = null;
      removeMoveEnd?.();
      removeMoveEnd = null;
      if (onStackChanged) {
        mapStackEventTarget?.removeEventListener?.(
          'gev:map-stack-changed',
          onStackChanged,
        );
        onStackChanged = null;
      }
      network = null;
      error = null;
      lastUpdate = null;
      viewer = null;
    },

    getStats() {
      const surface = scene?.stats();
      return {
        count: scene ? network.stations.length : 0,
        lineCount: scene ? network.lines.length : 0,
        stationCount: scene ? network.stations.length : 0,
        lastUpdate,
        loading: Boolean(pending),
        loadingLabel: pending ? t('loading...') : '',
        error,
        labelCount: labels.count(),
        pendingHeights: surface?.pendingHeights ?? 0,
        samplingUnsupported: surface?.samplingUnsupported ?? false,
      };
    },
  };
}
