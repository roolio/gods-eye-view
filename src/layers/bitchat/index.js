import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { geohashBounds, precisionForHeight } from './records.js';
import { showBitchatCard } from './card.js';
export { createBitchatSource } from './source.js';
export { geohashBounds, precisionForHeight } from './records.js';

/** Own batched activity geometry and its transient anonymous message card. */
export function createBitchatLayer({
  source,
  showCard = showBitchatCard,
  now = () => Date.now(),
} = {}) {
  if (
    typeof source?.getSnapshot !== 'function' ||
    typeof source?.getMessages !== 'function'
  )
    throw new TypeError('Bitchat requires snapshot and message sources');
  let viewer, ground, outlines, handler, request, messageRequest, removeCard;
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
    removeCard?.();
    removeCard = null;
  }
  async function select(geohash) {
    const cell = cells.find((row) => row.geohash === geohash);
    if (!enabled || !cell) return;
    clearCard();
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
      removeCard = showCard(viewer.container, cell, data, now());
    } catch {
      if (!controller.signal.aborted) error = t('Bitchat messages unavailable');
    }
  }
  function render(snapshot) {
    const signature = JSON.stringify([
      snapshot.cells.map(({ geohash, people }) => [geohash, people]),
      snapshot.coarse.map(({ geohash }) => geohash),
    ]);
    if (signature === renderSignature) return;
    renderSignature = signature;
    ground.removeAll();
    outlines.removeAll();
    const max = Math.max(1, ...snapshot.cells.map((cell) => cell.people));
    if (snapshot.cells.length)
      ground.add(
        new Cesium.GroundPrimitive({
          geometryInstances: snapshot.cells.map((cell) => {
            const bounds = geohashBounds(cell.geohash);
            const intensity = Math.log1p(cell.people) / Math.log1p(max);
            return new Cesium.GeometryInstance({
              id: `bitchat:${cell.geohash}`,
              geometry: new Cesium.RectangleGeometry({
                rectangle: Cesium.Rectangle.fromDegrees(
                  bounds.west,
                  bounds.south,
                  bounds.east,
                  bounds.north,
                ),
                vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
              }),
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                  Cesium.Color.fromHsl(
                    0.45 - 0.45 * intensity,
                    0.9,
                    0.55,
                  ).withAlpha(0.3 + 0.4 * intensity),
                ),
              },
            });
          }),
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          classificationType: Cesium.ClassificationType.BOTH,
          releaseGeometryInstances: false,
        }),
      );
    if (snapshot.coarse.length)
      outlines.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: snapshot.coarse.map((cell) => {
            const b = geohashBounds(cell.geohash);
            return new Cesium.GeometryInstance({
              geometry: new Cesium.GroundPolylineGeometry({
                positions: Cesium.Cartesian3.fromDegreesArray([
                  b.west,
                  b.south,
                  b.east,
                  b.south,
                  b.east,
                  b.north,
                  b.west,
                  b.north,
                  b.west,
                  b.south,
                ]),
                width: 1,
              }),
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                  Cesium.Color.WHITE.withAlpha(0.25),
                ),
              },
            });
          }),
          appearance: new Cesium.PolylineColorAppearance(),
          allowPicking: false,
        }),
      );
    viewer.scene.requestRender?.();
  }
  const layer = {
    id: 'bitchat',
    name: 'Bitchat activity',
    icon: '◉',
    source: 'Bitchat · Nostr',
    updateInterval: 15000,
    init(nextViewer) {
      if (viewer) throw new Error('Bitchat is already initialized');
      viewer = nextViewer;
      ground = viewer.scene.groundPrimitives.add(
        new Cesium.PrimitiveCollection(),
      );
      outlines = viewer.scene.groundPrimitives.add(
        new Cesium.PrimitiveCollection(),
      );
      ground.id = 'bitchat';
      outlines.id = 'bitchat-coarse';
      ground.show = outlines.show = false;
      if (viewer.scene.canvas) {
        handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handler.setInputAction(({ position }) => {
          if (!enabled) return;
          const id = viewer.scene.pick(position)?.id;
          if (typeof id === 'string' && id.startsWith('bitchat:'))
            void select(id.slice(8));
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
    },
    enable() {
      enabled = true;
      if (ground) ground.show = outlines.show = true;
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      clearCard();
      renderSignature = null;
      cells = [];
      if (ground) {
        ground.removeAll();
        outlines.removeAll();
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
              viewer.camera?.positionCartographic?.height ?? Infinity,
            ),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        clearCard();
        render(snapshot);
        cells = snapshot.cells;
        status = snapshot.status;
        relayStatus = snapshot.relays;
        lastUpdate = now();
        error = null;
        return true;
      } catch (failure) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        error = failure.message;
        status = 'down';
        renderSignature = null;
        cells = [];
        ground.removeAll();
        outlines.removeAll();
        clearCard();
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) request = null;
      }
    },
    destroy() {
      layer.disable();
      handler?.destroy();
      handler = null;
      if (ground) {
        viewer.scene.groundPrimitives.remove(ground);
        viewer.scene.groundPrimitives.remove(outlines);
      }
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
