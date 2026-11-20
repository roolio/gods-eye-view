import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { t } from '../../i18n/index.js';
import { inputFor as defaultInputFor } from '../../input/dispatcher.js';
import { hslColor } from '../../render/color.js';
import { drawOf, findCamera, findFrame } from '../../render/rendererOf.js';
import { geohashBounds, precisionForHeight } from './records.js';
import { BITCHAT_CARD_SOURCE_ID, buildBitchatCard } from './cards.js';
export { createBitchatSource } from './source.js';
export { geohashBounds, precisionForHeight } from './records.js';

/** The coarse cells' outline colour: white at a quarter alpha. */
const COARSE_OUTLINE = [1, 1, 1, 0.25];
/** Each layer instance draws in its own sets (`bitchat:1`, ...). */
let instances = 0;

/**
 * Own batched activity geometry and its transient anonymous message card.
 *
 * The cells are draped rectangles in one renderer draw set and the coarse
 * cells' outlines draped lines in another (`drawOf(viewer)`), made at
 * `init`. Clicks come through the one input dispatcher (`inputFor`). Given a
 * Cesium viewer with no renderer bound, the caller loads the package's
 * `./render/cesium/unbound` export first.
 */
export function createBitchatLayer({
  source,
  overlayHost,
  picking,
  inputFor = defaultInputFor,
  now = () => Date.now(),
} = {}) {
  if (
    typeof source?.getSnapshot !== 'function' ||
    typeof source?.getMessages !== 'function'
  )
    throw new TypeError('Bitchat requires snapshot and message sources');
  let viewer, ground, outlines, clickSubscription, request, messageRequest;
  let selected = null;
  let renderSignature = null;
  let enabled = false,
    cells = [],
    status = 'warming',
    lastUpdate = null,
    error = null,
    relayStatus = { listed: 0, open: 0 };
  function clearCard() {
    messageRequest?.abort();
    messageRequest = null;
    selected = null;
    overlayHost?.clearSource(BITCHAT_CARD_SOURCE_ID);
  }
  async function select(geohash) {
    const cell = cells.find((row) => row.geohash === geohash);
    if (!enabled || !cell) return;
    messageRequest?.abort();
    selected = geohash;
    const controller = new AbortController();
    messageRequest = controller;
    try {
      const data = await source.getMessages(geohash, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        messageRequest !== controller ||
        !enabled
      )
        return;
      if (data.people < 3 || !cells.some((row) => row.geohash === geohash)) {
        clearCard();
        return;
      }
      const bounds = geohashBounds(geohash);
      overlayHost?.setEntries(
        BITCHAT_CARD_SOURCE_ID,
        [
          {
            ...buildBitchatCard(cell, data, now()),
            position: fromDegrees(
              (bounds.west + bounds.east) / 2,
              (bounds.south + bounds.north) / 2,
            ),
          },
        ],
        { cohortLimit: 1, collisionCapacity: 1, moving: false },
      );
      findFrame(viewer)?.requestRender?.('bitchat');
    } catch {
      if (!controller.signal.aborted && messageRequest === controller) {
        clearCard();
        error = t('Bitchat messages unavailable');
      }
    }
  }
  function render(snapshot) {
    const signature = JSON.stringify([
      snapshot.cells.map(({ geohash, people }) => [geohash, people]),
      snapshot.coarse.map(({ geohash }) => geohash),
    ]);
    if (signature === renderSignature) return;
    renderSignature = signature;
    const max = Math.max(1, ...snapshot.cells.map((cell) => cell.people));
    ground.set(
      snapshot.cells.map((cell) => {
        const intensity = Math.log1p(cell.people) / Math.log1p(max);
        return {
          id: `bitchat:${cell.geohash}`,
          geometry: { kind: 'rectangle', rect: geohashBounds(cell.geohash) },
          fill: hslColor(
            0.45 - 0.45 * intensity,
            0.9,
            0.55,
            0.3 + 0.4 * intensity,
          ),
          height: 'clampGround',
          lit: false,
        };
      }),
    );
    outlines.set(
      snapshot.coarse.map((cell) => {
        const b = geohashBounds(cell.geohash);
        return {
          id: `bitchat-coarse:${cell.geohash}`,
          positions: [
            [b.west, b.south],
            [b.east, b.south],
            [b.east, b.north],
            [b.west, b.north],
            [b.west, b.south],
          ].map(([lon, lat]) => fromDegrees(lon, lat)),
          widthPx: 1,
          mode: 'draped',
          style: { kind: 'solid', color: COARSE_OUTLINE },
        };
      }),
    );
  }
  /** The cell under a click's surface point, if any. */
  function cellAt(event) {
    const point = event.ground();
    const at = point && toLonLatH(point);
    if (!at) return null;
    return (
      cells.find(({ geohash }) => {
        const b = geohashBounds(geohash);
        return (
          at.lon >= b.west &&
          at.lon <= b.east &&
          at.lat >= b.south &&
          at.lat <= b.north
        );
      }) ?? null
    );
  }
  const layer = {
    id: 'bitchat',
    name: 'Bitchat activity',
    icon: '◉',
    source: 'Bitchat · Nostr',
    updateInterval: 15000,
    init(nextViewer) {
      if (viewer) throw new Error('Bitchat is already initialized');
      const draw = drawOf(nextViewer);
      const n = ++instances;
      // The cells never take part in picks: contacts and other layers' ground
      // geometry under them stay pickable, and clicks find a cell by position.
      ground = draw.shapes({
        id: `bitchat:${n}`,
        clampTo: 'both',
        blend: 'translucent',
        pickable: false,
        show: false,
      });
      outlines = draw.lines({
        id: `bitchat-coarse:${n}`,
        clampTo: 'both',
        pickable: false,
        show: false,
      });
      viewer = nextViewer;
      overlayHost?.setVisible(BITCHAT_CARD_SOURCE_ID, false);
    },
    enable() {
      enabled = true;
      overlayHost?.setVisible(BITCHAT_CARD_SOURCE_ID, true);
      if (!clickSubscription && inputFor && picking && viewer) {
        // Ground rectangles leave contact picks to the layers above them.
        // The dispatcher delivers clicks only while no tool holds the pointer.
        clickSubscription = inputFor(viewer).onClick((event) => {
          // A card or label painted over the map took the click.
          if (!enabled || event.overlay) return;
          const id = picking.resolvePickId(event.topHit);
          if (picking.isOwnedByOtherLayer('bitchat', id)) return;
          const cell = cellAt(event);
          if (cell) void select(cell.geohash);
          else clearCard();
        });
      }
      if (ground) ground.show = outlines.show = true;
    },
    disable() {
      enabled = false;
      clickSubscription?.();
      clickSubscription = null;
      overlayHost?.setVisible(BITCHAT_CARD_SOURCE_ID, false);
      request?.abort();
      request = null;
      clearCard();
      renderSignature = null;
      cells = [];
      if (ground) {
        ground.clear();
        outlines.clear();
        ground.show = outlines.show = false;
      }
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || !ground || signal?.aborted) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const snapshot = await source.getSnapshot(
          {
            precision: precisionForHeight(
              findCamera(viewer)?.pose().height ?? Infinity,
            ),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        render(snapshot);
        cells = snapshot.cells;
        status = snapshot.status;
        relayStatus = snapshot.relays;
        lastUpdate = now();
        error = null;
        if (selected) {
          if (cells.some((cell) => cell.geohash === selected))
            await select(selected);
          else clearCard();
        }
        return true;
      } catch (failure) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        error = failure.message;
        status = 'down';
        renderSignature = null;
        cells = [];
        ground.clear();
        outlines.clear();
        clearCard();
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) request = null;
      }
    },
    destroy() {
      layer.disable();
      ground?.dispose();
      outlines?.dispose();
      ground = outlines = viewer = null;
    },
    getStats() {
      return {
        count: cells.length,
        status,
        loading: status === 'warming',
        degraded: status === 'degraded',
        lastUpdate,
        error,
        fallback: false,
        relays: relayStatus,
      };
    },
    getRowControls() {
      return {
        chips: [],
        info: t('{open}/{listed} relays · {status}', {
          ...relayStatus,
          status,
        }),
        infoTitle: t(
          'At least three active keys per cell. Counts use the largest channel-level cohort. Public relay coverage is incomplete.',
        ),
      };
    },
  };
  return layer;
}
