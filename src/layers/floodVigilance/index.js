import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import {
  cableClassificationTypeForScene,
  cableClassificationTypeForStack,
} from '../submarineCables/index.js';
import {
  FLOOD_CARD_SOURCE_ID,
  buildSectionCard,
  formatUtcTime,
} from './cards.js';
import { FLOOD_VIGILANCE_LAYER_ID, VIGILANCE_LEVELS } from './records.js';
import { SECTION_PICK_PREFIX, createSectionScene } from './scene.js';
export { COVERAGE, FLOOD_VIGILANCE_LAYER_ID } from './records.js';
export { createFloodVigilanceSource } from './source.js';

const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Midpoint of a section's longest path, for a card with no click position. */
function sectionAnchor(section) {
  const path = section.paths.reduce((a, b) => (b.length > a.length ? b : a));
  const i = Math.floor(path.length / 4) * 2;
  return Cesium.Cartesian3.fromDegrees(path[i], path[i + 1]);
}

/**
 * Flood Vigilance (France): Vigicrues river sections coloured by their
 * vigilance level.
 * @param {object} deps
 * @param {{label: string, getSections: Function}} deps.source
 * @param {{setEntries: Function, setVisible: Function, clearSource: Function}} deps.overlayHost
 * @param {Function|null} [deps.screenSpaceEventHandlerFactory]
 * @param {{resolvePickId: Function, isOwnedByOtherLayer: Function}|null} [deps.picking]
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
  if (typeof source?.getSections !== 'function' || !source.label)
    throw new TypeError('Flood vigilance requires a sections source');
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
  let clickHandler = null;
  let onStackChanged = null;
  /** @type {{id: string, position: Cesium.Cartesian3}|null} */
  let selected = null;
  const sectionsById = new Map();

  const requestRender = () => viewer?.scene?.requestRender?.();

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

  function publishCard() {
    const section = selected && sectionsById.get(selected.id);
    if (!section) {
      selected = null;
      overlayHost.setEntries(FLOOD_CARD_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    overlayHost.setEntries(
      FLOOD_CARD_SOURCE_ID,
      [
        {
          ...buildSectionCard(section, bulletin),
          position: selected.position,
        },
      ],
      CARD_HOST_OPTIONS,
    );
    requestRender();
  }

  function clearSelection() {
    selected = null;
    overlayHost.clearSource(FLOOD_CARD_SOURCE_ID);
  }

  function pickedSectionId(picked) {
    const id = picking.resolvePickId(picked);
    if (typeof id !== 'string' || !id.startsWith(SECTION_PICK_PREFIX))
      return null;
    const sectionId = id.slice(SECTION_PICK_PREFIX.length);
    return sectionsById.has(sectionId) ? sectionId : null;
  }

  function onClick(click) {
    if (!enabled || (pointer && !pointer.isPointerFree())) return;
    const picked = viewer.scene.pick(click.position);
    const sectionId = picked ? pickedSectionId(picked) : null;
    if (sectionId) {
      selected = {
        id: sectionId,
        position:
          viewer.camera.pickEllipsoid(click.position) ??
          sectionAnchor(sectionsById.get(sectionId)),
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
    // Not registered as a pick owner: like fire perimeters, long ground lines
    // would otherwise make sibling layers' clicks inert wherever they cross.
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  function removeClickHandler() {
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
    removeClickHandler();
    clearSelection();
    overlayHost.setVisible(FLOOD_CARD_SOURCE_ID, false);
    unmountSections();
  }

  function levelCount(level) {
    return bulletin
      ? bulletin.sections.filter((section) => section.level === level).length
      : 0;
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
      installClickHandler();
      mountSections();
    },

    disable,

    async update() {
      if (!enabled || !viewer) return false;
      request?.abort();
      const mine = new AbortController();
      request = mine;
      try {
        const next = await source.getSections({ signal: mine.signal });
        if (mine.signal.aborted || request !== mine || !enabled) return false;
        applyBulletin(next);
        lastUpdate = now();
        error = null;
        return true;
      } catch (failure) {
        if (mine.signal.aborted || request !== mine || !enabled) return false;
        // A feed failure keeps the layer on: the last bulletin stays drawn,
        // the row reports the error and the next interval retries.
        error = failure?.message || msg('Vigicrues feed unavailable');
        console.warn('[Data:FloodVigilance]', error);
        return true;
      } finally {
        if (request === mine) request = null;
      }
    },

    destroy() {
      disable();
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
      lastUpdate = null;
      error = null;
      viewer = null;
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
          ? tn(
              levelCount(2) + levelCount(3) + levelCount(4),
              '{count} river section above green',
              '{count} river sections above green',
            )
          : '',
      };
    },

    getAnalystRecords(maxCount = 500) {
      if (!enabled || !bulletin) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return bulletin.sections
        .slice()
        .sort((a, b) => b.level - a.level || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(({ id, name, level }) => ({
          id,
          kind: 'river-section',
          name,
          level,
          publishedAt: bulletin.publishedAt,
        }));
    },

    getStats() {
      return {
        count: bulletin?.sections.length ?? 0,
        levels: Object.fromEntries(
          VIGILANCE_LEVELS.map(({ level }) => [level, levelCount(level)]),
        ),
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
