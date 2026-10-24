import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  cableClassificationTypeForScene,
  cableClassificationTypeForStack,
} from '../submarineCables/index.js';
import {
  FLOOD_CARD_SOURCE_ID,
  buildSectionCard,
  buildStationCard,
  formatUtcTime,
} from './cards.js';
import {
  FLOOD_VIGILANCE_LAYER_ID,
  VIGILANCE_LEVELS,
  stationIsStale,
} from './records.js';
import { SECTION_PICK_PREFIX, createSectionScene } from './scene.js';
import {
  STATIONS_MAX_HEIGHT_M,
  STATION_LABELS_MAX_HEIGHT_M,
  STATION_LABEL_COHORT_LIMIT,
  STATION_LABEL_SOURCE_ID,
  STATION_PICK_PREFIX,
  createStationScene,
  stationQueryBox,
  stationQueryKey,
} from './stations.js';
export { COVERAGE, FLOOD_VIGILANCE_LAYER_ID } from './records.js';
export { createFloodVigilanceSource } from './source.js';

const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: STATION_LABEL_COHORT_LIMIT,
  collisionCapacity: STATION_LABEL_COHORT_LIMIT,
  moving: false,
});
/** Station readings older than this are refetched for the same view. */
const STATIONS_REFRESH_MS = 5 * 60_000;
const CAMERA_DEBOUNCE_MS = 700;

/** Midpoint of a section's longest path, for a card with no click position. */
function sectionAnchor(section) {
  const path = section.paths.reduce((a, b) => (b.length > a.length ? b : a));
  const i = Math.floor(path.length / 4) * 2;
  return Cesium.Cartesian3.fromDegrees(path[i], path[i + 1]);
}

/**
 * The visible rectangle in degrees, capped to the query box around the view
 * centre: a low view asks for one or two tiles, a wide or tilted one twelve.
 */
function viewBox(viewer) {
  const cap = stationQueryBox(viewCentre(viewer));
  const rectangle = viewer.camera.computeViewRectangle?.();
  if (!rectangle) return cap;
  const deg = Cesium.Math.toDegrees;
  const box = {
    west: Math.max(cap.west, deg(rectangle.west)),
    south: Math.max(cap.south, deg(rectangle.south)),
    east: Math.min(cap.east, deg(rectangle.east)),
    north: Math.min(cap.north, deg(rectangle.north)),
  };
  return box.west < box.east && box.south < box.north ? box : cap;
}

/** Degrees under the screen centre, else under the camera. */
function viewCentre(viewer) {
  const canvas = viewer.scene.canvas;
  const centre =
    canvas?.clientWidth > 0 &&
    canvas.clientHeight > 0 &&
    viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
  const carto = centre
    ? Cesium.Cartographic.fromCartesian(centre)
    : viewer.camera.positionCartographic;
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
  };
}

/**
 * Flood Vigilance (France): Vigicrues river sections coloured by their
 * vigilance level and, once the camera is low enough, Hub'Eau gauging
 * stations with their latest height.
 * @param {object} deps
 * @param {{label: string, getSections: Function, getStations: Function}} deps.source
 * @param {{setEntries: Function, setVisible: Function, clearSource: Function}} deps.overlayHost
 * @param {Function|null} [deps.screenSpaceEventHandlerFactory]
 * @param {{resolvePickId: Function, isOwnedByOtherLayer: Function, registerPickOwner?: Function, unregisterPickOwner?: Function}|null} [deps.picking]
 * @param {{isPointerFree(): boolean}|null} [deps.pointer]
 * @param {EventTarget|null} [deps.mapStackEventTarget] window in the app.
 * @param {() => number} [deps.now]
 * @returns {object} Catalog layer.
 */
export function createFloodVigilanceLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  mapStackEventTarget = null,
  now = () => Date.now(),
}) {
  if (
    typeof source?.getSections !== 'function' ||
    typeof source.getStations !== 'function' ||
    !source.label
  )
    throw new TypeError(
      'Flood vigilance requires a sections and stations source',
    );
  if (!overlayHost)
    throw new TypeError('Flood vigilance requires an overlay host');

  let viewer = null;
  let enabled = false;
  let classificationType = Cesium.ClassificationType.BOTH;
  /** @type {{sections: import('./records.js').FloodSection[], publishedAt: number|null, stale: boolean}|null} */
  let bulletin = null;
  let signature = null;
  let sectionScene = null;
  let request = null;
  let lastUpdate = null;
  let error = null;
  /** @type {import('./records.js').StationReading[]} */
  let stations = [];
  let stationScene = null;
  let stationsKey = null;
  let stationsFetchedAt = -Infinity;
  let stationRequest = null;
  let stationError = null;
  let stationsShown = false;
  let cameraTimer = null;
  let removeMoveEnd = null;
  let clickHandler = null;
  let onStackChanged = null;
  /** @type {{kind: 'section'|'station', id: string, position: Cesium.Cartesian3}|null} */
  let selected = null;
  const sectionsById = new Map();
  const stationsById = new Map();
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();

  const requestRender = () => viewer?.scene?.requestRender?.();
  const cameraHeight = () =>
    viewer?.camera?.positionCartographic?.height ?? Infinity;

  function mountSections() {
    if (sectionScene || !enabled || !viewer || !bulletin) return;
    sectionScene = createSectionScene(viewer, bulletin.sections, {
      classificationType,
    });
    requestRender();
  }

  function unmountSections() {
    sectionScene?.dispose();
    sectionScene = null;
  }

  function publishLabels() {
    const entries =
      stationsShown &&
      stationScene &&
      cameraHeight() < STATION_LABELS_MAX_HEIGHT_M
        ? stationScene.labelEntries()
        : [];
    overlayHost.setEntries(
      STATION_LABEL_SOURCE_ID,
      entries,
      LABEL_HOST_OPTIONS,
    );
  }

  function showStations(visible) {
    if (stationsShown !== (visible && Boolean(stationScene))) notify();
    stationsShown = visible && Boolean(stationScene);
    stationScene?.setVisible(stationsShown);
    publishLabels();
    if (!stationsShown && selected?.kind === 'station') {
      selected = null;
      publishCard();
    }
    requestRender();
  }

  function mountStations(next) {
    stationScene?.dispose();
    stations = next;
    stationsById.clear();
    for (const station of next) stationsById.set(station.id, station);
    stationScene = createStationScene(viewer, next, now());
    showStations(true);
    if (selected) publishCard();
  }

  function unmountStations() {
    stationScene?.dispose();
    stationScene = null;
    stationsShown = false;
    overlayHost.clearSource(STATION_LABEL_SOURCE_ID);
  }

  /** Fetch the gauges of the current view when it changed or aged. */
  async function refreshStations() {
    if (!enabled || !viewer) return;
    if (cameraHeight() > STATIONS_MAX_HEIGHT_M) {
      stationRequest?.abort();
      stationRequest = null;
      showStations(false);
      return;
    }
    const box = viewBox(viewer);
    const key = stationQueryKey(box);
    if (
      key === stationsKey &&
      now() - stationsFetchedAt < STATIONS_REFRESH_MS
    ) {
      showStations(true);
      return;
    }
    if (stationRequest?.key === key) return stationRequest.promise;
    stationRequest?.abort();
    const controller = new AbortController();
    const mine = {
      key,
      abort: () => controller.abort(),
      promise: (async () => {
        try {
          const result = await source.getStations(box, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || stationRequest !== mine || !enabled)
            return;
          stationsKey = key;
          stationsFetchedAt = now();
          stationError = null;
          mountStations(result.stations);
          notify();
        } catch (failure) {
          if (controller.signal.aborted || stationRequest !== mine || !enabled)
            return;
          stationError = failure?.message || msg("Hub'Eau feed unavailable");
          console.warn('[Data:FloodVigilance] stations', stationError);
          notify();
        } finally {
          if (stationRequest === mine) stationRequest = null;
        }
      })(),
    };
    stationRequest = mine;
    notify();
    return mine.promise;
  }

  function scheduleStations() {
    if (!enabled) return;
    clearTimeout(cameraTimer);
    // Labels follow the camera at once; the request waits for it to settle.
    publishLabels();
    cameraTimer = setTimeout(() => {
      cameraTimer = null;
      void refreshStations();
    }, CAMERA_DEBOUNCE_MS);
  }

  function publishCard() {
    const item =
      selected &&
      (selected.kind === 'section'
        ? sectionsById.get(selected.id)
        : stationsById.get(selected.id));
    if (!item) {
      selected = null;
      overlayHost.setEntries(FLOOD_CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card =
      selected.kind === 'section'
        ? buildSectionCard(item, bulletin)
        : buildStationCard(item, now());
    overlayHost.setEntries(
      FLOOD_CARD_SOURCE_ID,
      [{ ...card, position: selected.position }],
      CARD_HOST_OPTIONS,
    );
    requestRender();
  }

  function clearSelection() {
    selected = null;
    overlayHost.clearSource(FLOOD_CARD_SOURCE_ID);
  }

  /** This layer's pick as {kind, id}, or null. */
  function pickedItem(picked) {
    const id = picking.resolvePickId(picked);
    if (typeof id !== 'string') return null;
    if (id.startsWith(STATION_PICK_PREFIX) && stationsShown) {
      const stationId = id.slice(STATION_PICK_PREFIX.length);
      return stationsById.has(stationId)
        ? { kind: 'station', id: stationId }
        : null;
    }
    if (id.startsWith(SECTION_PICK_PREFIX)) {
      const sectionId = id.slice(SECTION_PICK_PREFIX.length);
      return sectionsById.has(sectionId)
        ? { kind: 'section', id: sectionId }
        : null;
    }
    return null;
  }

  function onClick(click) {
    if (!enabled || (pointer && !pointer.isPointerFree())) return;
    const picked = viewer.scene.pick(click.position);
    const item = picked ? pickedItem(picked) : null;
    if (item) {
      const station =
        item.kind === 'station' &&
        stationScene.records.find((record) => record.station.id === item.id);
      selected = {
        ...item,
        position: station
          ? station.position
          : (viewer.camera.pickEllipsoid(click.position) ??
            sectionAnchor(sectionsById.get(item.id))),
      };
      publishCard();
      return;
    }
    // Another layer's object is not empty space: leave the selection alone.
    const pickId = picked ? picking.resolvePickId(picked) : null;
    if (pickId && picking.isOwnedByOtherLayer(FLOOD_VIGILANCE_LAYER_ID, pickId))
      return;
    if (selected) {
      selected = null;
      publishCard();
    }
  }

  function installClickHandler() {
    if (clickHandler || !viewer || !screenSpaceEventHandlerFactory || !picking)
      return;
    // Only the station dots claim their picks. Like fire perimeters, long
    // ground lines would otherwise make sibling clicks inert where they cross.
    picking.registerPickOwner?.(FLOOD_VIGILANCE_LAYER_ID, (id) =>
      id.startsWith(STATION_PICK_PREFIX),
    );
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  function removeClickHandler() {
    if (clickHandler) picking?.unregisterPickOwner?.(FLOOD_VIGILANCE_LAYER_ID);
    clickHandler?.destroy();
    clickHandler = null;
  }

  function applyBulletin(next) {
    const nextSignature = JSON.stringify(
      next.sections.map(({ id, level, paths }) => [id, level, paths.length]),
    );
    bulletin = next;
    sectionsById.clear();
    for (const section of next.sections) sectionsById.set(section.id, section);
    if (nextSignature !== signature) {
      signature = nextSignature;
      unmountSections();
    }
    mountSections();
    if (selected) publishCard();
  }

  function disable() {
    enabled = false;
    request?.abort();
    request = null;
    stationRequest?.abort();
    stationRequest = null;
    clearTimeout(cameraTimer);
    cameraTimer = null;
    removeClickHandler();
    clearSelection();
    overlayHost.setVisible(FLOOD_CARD_SOURCE_ID, false);
    overlayHost.setVisible(STATION_LABEL_SOURCE_ID, false);
    unmountSections();
    unmountStations();
    // A later enable refetches the stations of whatever view it lands on.
    stationsKey = null;
  }

  function levelCount(level) {
    return bulletin
      ? bulletin.sections.filter((section) => section.level === level).length
      : 0;
  }

  function stationsInfo() {
    if (cameraHeight() > STATIONS_MAX_HEIGHT_M)
      return t('Zoom below {km} km to see gauging stations', {
        km: STATIONS_MAX_HEIGHT_M / 1000,
      });
    if (stationError)
      return t('Gauging stations: {error}', {
        error: translateFeedError(stationError),
      });
    if (!stationScene || stationRequest) return t('Loading gauging stations…');
    const stale = stations.filter((station) =>
      stationIsStale(station, now()),
    ).length;
    return tn(
      stations.length,
      '{count} gauging station in view, {stale} without a reading for 6 h',
      '{count} gauging stations in view, {stale} without a reading for 6 h',
      { stale },
    );
  }

  return {
    id: FLOOD_VIGILANCE_LAYER_ID,
    name: 'Flood Vigilance (France)',
    icon: '🌊',
    source: source.label,
    updateInterval: 5 * 60_000,

    init(v) {
      viewer = v;
      classificationType = cableClassificationTypeForScene(v?.scene);
      overlayHost.setVisible(FLOOD_CARD_SOURCE_ID, false);
      overlayHost.setVisible(STATION_LABEL_SOURCE_ID, false);
      removeMoveEnd ??= v?.camera?.moveEnd?.addEventListener(scheduleStations);
      if (!onStackChanged && mapStackEventTarget?.addEventListener) {
        onStackChanged = (event) => {
          classificationType = event?.detail?.activeId
            ? cableClassificationTypeForStack(event.detail.activeId)
            : cableClassificationTypeForScene(viewer?.scene);
          sectionScene?.setSurface(classificationType);
          requestRender();
        };
        mapStackEventTarget.addEventListener(
          'gev:map-stack-changed',
          onStackChanged,
        );
      }
    },

    enable(v) {
      viewer = v || viewer;
      enabled = true;
      overlayHost.setVisible(FLOOD_CARD_SOURCE_ID, true);
      overlayHost.setVisible(STATION_LABEL_SOURCE_ID, true);
      installClickHandler();
      mountSections();
    },

    disable,

    async update() {
      if (!enabled || !viewer) return false;
      request?.abort();
      const mine = new AbortController();
      request = mine;
      // Stations load and fail on their own, never holding up the bulletin.
      void refreshStations();
      try {
        const next = await source.getSections({ signal: mine.signal });
        if (mine.signal.aborted || request !== mine || !enabled) return false;
        applyBulletin(next);
        lastUpdate = now();
        error = null;
        notify();
        return true;
      } catch (failure) {
        if (mine.signal.aborted || request !== mine || !enabled) return false;
        // A feed failure keeps the layer on: the last bulletin stays drawn,
        // the row reports the error and the next interval retries.
        error = failure?.message || msg('Vigicrues feed unavailable');
        console.warn('[Data:FloodVigilance]', error);
        notify();
        return true;
      } finally {
        if (request === mine) request = null;
      }
    },

    destroy() {
      disable();
      removeMoveEnd?.();
      removeMoveEnd = null;
      if (onStackChanged) {
        mapStackEventTarget?.removeEventListener?.(
          'gev:map-stack-changed',
          onStackChanged,
        );
        onStackChanged = null;
      }
      bulletin = null;
      signature = null;
      sectionsById.clear();
      stations = [];
      stationsById.clear();
      stationError = null;
      lastUpdate = null;
      error = null;
      viewer = null;
      rowControlsListener = null;
    },

    getRowControls() {
      return {
        chips: [],
        legend: VIGILANCE_LEVELS.map(({ level, color, label }, index) => ({
          label: t(label),
          color,
          count: levelCount(level),
          ...(index === 0
            ? {
                blurb: bulletin?.publishedAt
                  ? t(
                      'Vigicrues bulletin {time} UTC. Published at 10:00 and 16:00 French time, more often during floods.',
                      { time: formatUtcTime(bulletin.publishedAt) },
                    )
                  : t(
                      'Vigicrues publishes at 10:00 and 16:00 French time, more often during floods.',
                    ),
              }
            : {}),
        })),
        info: bulletin
          ? `${tn(
              levelCount(2) + levelCount(3) + levelCount(4),
              '{count} river section above green',
              '{count} river sections above green',
            )} · ${stationsInfo()}`
          : '',
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getAnalystRecords(maxCount = 500) {
      if (!enabled || !bulletin) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      const sections = bulletin.sections
        .slice()
        .sort((a, b) => b.level - a.level || a.id.localeCompare(b.id))
        .map(({ id, name, level }) => ({
          id,
          kind: 'river-section',
          name,
          level,
          publishedAt: bulletin.publishedAt,
        }));
      const gauges = stationsShown
        ? stations.map((station) => ({
            id: station.id,
            kind: 'gauging-station',
            name: station.name,
            river: station.river,
            lat: station.lat,
            lon: station.lon,
            heightM: station.height?.value ?? null,
            flowM3s: station.flow?.value ?? null,
            trend: station.trend?.direction ?? null,
            observedAt: station.height?.observedAt ?? null,
            stale: stationIsStale(station, now()),
          }))
        : [];
      return [...sections, ...gauges].slice(0, limit);
    },

    getStats() {
      return {
        count: bulletin?.sections.length ?? 0,
        levels: Object.fromEntries(
          VIGILANCE_LEVELS.map(({ level }) => [level, levelCount(level)]),
        ),
        stationCount: stationsShown ? stations.length : 0,
        stationsLoading: Boolean(stationRequest),
        stationError,
        lastUpdate,
        observedAt: bulletin?.publishedAt ?? null,
        loading: Boolean(request) && !bulletin,
        error,
        stale: bulletin?.stale === true,
        fallback: false,
        selectedId: selected?.id ?? null,
      };
    },
  };
}
