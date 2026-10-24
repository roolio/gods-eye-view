import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { geohashBounds, precisionForHeight } from './records.js';
import { BITCHAT_CARD_SOURCE_ID, buildBitchatCard } from './cards.js';
export { createBitchatSource } from './source.js';
export { geohashBounds, precisionForHeight } from './records.js';

/** Own batched activity geometry and its transient anonymous message card. */
export function createBitchatLayer({
  source,
  overlayHost,
  picking,
  pointer,
  screenSpaceEventHandlerFactory,
  now = () => Date.now(),
} = {}) {
  if (
    typeof source?.getSnapshot !== 'function' ||
    typeof source?.getMessages !== 'function'
  )
    throw new TypeError('Bitchat requires snapshot and message sources');
  let viewer, ground, outlines, handler, request, messageRequest;
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
            position: Cesium.Cartesian3.fromDegrees(
              (bounds.west + bounds.east) / 2,
              (bounds.south + bounds.north) / 2,
            ),
          },
        ],
        { cohortLimit: 1, collisionCapacity: 1, moving: false },
      );
      viewer.scene.requestRender?.();
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
          allowPicking: false,
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
      overlayHost?.setVisible(BITCHAT_CARD_SOURCE_ID, false);
    },
    enable() {
      enabled = true;
      overlayHost?.setVisible(BITCHAT_CARD_SOURCE_ID, true);
      if (!handler && screenSpaceEventHandlerFactory && picking) {
        // Ground rectangles leave contact picks to the layers above them.
        handler = screenSpaceEventHandlerFactory(viewer);
        handler.setInputAction(({ position }) => {
          if (!enabled || (pointer && !pointer.isPointerFree())) return;
          const id = picking.resolvePickId(viewer.scene.pick(position));
          if (picking.isOwnedByOtherLayer('bitchat', id)) return;
          const ray = viewer.camera.getPickRay?.(position);
          const point =
            (ray && viewer.scene.globe?.pick(ray, viewer.scene)) ??
            viewer.camera.pickEllipsoid?.(position);
          const carto = point && Cesium.Cartographic.fromCartesian(point);
          const lon = carto && Cesium.Math.toDegrees(carto.longitude);
          const lat = carto && Cesium.Math.toDegrees(carto.latitude);
          const cell =
            carto &&
            cells.find(({ geohash }) => {
              const b = geohashBounds(geohash);
              return (
                lon >= b.west &&
                lon <= b.east &&
                lat >= b.south &&
                lat <= b.north
              );
            });
          if (cell) void select(cell.geohash);
          else clearCard();
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      if (ground) ground.show = outlines.show = true;
    },
    disable() {
      enabled = false;
      handler?.destroy();
      handler = null;
      overlayHost?.setVisible(BITCHAT_CARD_SOURCE_ID, false);
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
