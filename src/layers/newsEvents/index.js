import * as Cesium from 'cesium';
import {
  NEWS_EVENTS_OVERLAY_SOURCE_ID,
  NEWS_EVENT_COLORS,
  buildNewsEventCard,
  newsEventCategoryLabel,
} from './cards.js';
import { NEWS_EVENT_CATEGORIES } from './records.js';
import { msg, t } from '../../i18n/index.js';
export * from './records.js';
export * from './cards.js';
export { createGdeltNewsEventsSource } from './source.js';

const PICK_PREFIX = 'news-event:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Marker size in pixels: grows with coverage, log-scaled so capitals stay legible. */
export function newsEventPixelSize(articleCount) {
  const count = Math.max(1, Number(articleCount) || 1);
  return Math.min(18, 5 + 2 * Math.log2(count));
}

/**
 * A fixed marker position on the ground, never clamped. With Google 3D tiles
 * the globe is hidden, so CLAMP_TO_GROUND samples whatever coarse tile is
 * loaded: markers sank 5 to 150 km under the surface and changed depth with
 * every zoom, and an always-on-top point that deep slides off its place as
 * the camera moves. The globe height is used only when the globe is drawn.
 */
function markerPosition(viewer, row) {
  const globe = viewer?.scene?.globe;
  const ground = globe?.show
    ? globe.getHeight?.(Cesium.Cartographic.fromDegrees(row.lon, row.lat))
    : null;
  return Cesium.Cartesian3.fromDegrees(
    row.lon,
    row.lat,
    Number.isFinite(ground) ? ground : 0,
  );
}

/**
 * Horizon occluder sunk 1 km below WGS84, as in the street-level cones: ground
 * can lie below the ellipsoid, and an occluder at 0 m would hide markers on it.
 */
const HORIZON_DEPTH_M = 1000;
const HORIZON_ELLIPSOID = new Cesium.Ellipsoid(
  Cesium.Ellipsoid.WGS84.radii.x - HORIZON_DEPTH_M,
  Cesium.Ellipsoid.WGS84.radii.y - HORIZON_DEPTH_M,
  Cesium.Ellipsoid.WGS84.radii.z - HORIZON_DEPTH_M,
);

/** Own one GDELT news-event display, its refresh lifecycle, and click selection. */
export function createNewsEventsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('News events require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedLink = null;
  let _selectedCardId = null;
  /** @type {Map<string, Object>} */
  const _rowById = new Map();
  /** @type {Array<{entity: Cesium.Entity, position: Cesium.Cartesian3}>} */
  let _markers = [];
  const _occluder = new Cesium.EllipsoidalOccluder(HORIZON_ELLIPSOID);
  let _culledFrom = null;
  let _stopCulling = null;

  /**
   * Hide markers behind the horizon. They skip the depth test and the globe
   * is hidden under Google 3D tiles, so nothing else stops the far side of
   * the planet drawing through it, sliding the wrong way as the camera moves.
   */
  function cullHorizon(force = false) {
    const position = _viewer?.camera?.positionWC;
    if (!position) return;
    if (
      !force &&
      _culledFrom &&
      Cesium.Cartesian3.equals(_culledFrom, position)
    )
      return;
    _culledFrom = Cesium.Cartesian3.clone(position, _culledFrom);
    _occluder.cameraPosition = position;
    for (const marker of _markers) {
      const show = _occluder.isPointVisible(marker.position);
      if (marker.entity.show !== show) marker.entity.show = show;
    }
  }

  function startCulling() {
    _stopCulling ||=
      _viewer?.scene?.preRender?.addEventListener(() => cullHorizon()) || null;
  }

  function stopCulling() {
    _stopCulling?.();
    _stopCulling = null;
    _culledFrom = null;
  }

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedLink = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        NEWS_EVENTS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    _selectedLink = openExternal ? (row.events[0]?.url ?? null) : null;
    const card = {
      ...buildNewsEventCard(row, Date.now(), { link: _selectedLink }),
      position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
    };
    if (_selectedLink) {
      const link = _selectedLink;
      // Keyboard/assistive activation mirrors the pointer click-through.
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      NEWS_EVENTS_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's location ids, or null. */
  function pickedLocationId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const locationId = pickId.slice(PICK_PREFIX.length);
    return _rowById.has(locationId) ? locationId : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Markers are small points, so claiming them cannot shadow sibling cards
    // the way large ground polygons would.
    picking.registerPickOwner?.(layer.id, (pickId) =>
      String(pickId).startsWith(PICK_PREFIX),
    );
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: NEWS_EVENTS_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink && openExternal) openExternal(_selectedLink);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const locationId = picked ? pickedLocationId(picked) : null;
      if (locationId) {
        _selectedId = locationId;
        publishSelectedCard();
        return;
      }
      // A pick that belongs to a sibling layer is not "empty space".
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    picking?.unregisterPickOwner?.(layer.id);
  }

  function clearSelection() {
    _selectedId = null;
    _selectedLink = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(NEWS_EVENTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(NEWS_EVENTS_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'news-events',
    name: 'News Events (24h)',
    icon: '📰',
    source: 'GDELT',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('News events layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('news-events');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:NewsEvents] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(NEWS_EVENTS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      startCulling();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      stopCulling();
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // Least-covered first, so a busy place draws (and picks) above the
        // single-article neighbours the geocoder puts next to it.
        const drawOrder = rows
          .slice()
          .sort((a, b) => a.articleCount - b.articleCount);
        const nextMarkers = drawOrder.map((row) => {
          const position = markerPosition(_viewer, row);
          return {
            position,
            entity: new Cesium.Entity({
              id: `${PICK_PREFIX}${row.stableId}`,
              position,
              point: {
                pixelSize: newsEventPixelSize(row.articleCount),
                color: Cesium.Color.fromCssColorString(
                  NEWS_EVENT_COLORS[row.dominant],
                ).withAlpha(0.85),
                outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
                outlineWidth: 1,
                // Always on top: a marker hidden behind 3D tiles is a lost report.
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }),
          };
        });
        _rowById.clear();
        for (const row of rows) _rowById.set(row.stableId, row);
        _dataSource.entities.suspendEvents();
        _dataSource.entities.removeAll();
        for (const { entity } of nextMarkers) _dataSource.entities.add(entity);
        _dataSource.entities.resumeEvents();
        _markers = nextMarkers;
        cullHorizon(true);
        // Refresh (or drop) the selected location's card against the new feed.
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:NewsEvents] Updated: ${_count} locations`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:NewsEvents] Fetch error:', e);
        _lastError = e?.message || msg('News events source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      stopCulling();
      _markers = [];
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Snapshot location aggregates for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        result.push({
          id: row.stableId,
          place: row.place,
          country: row.country,
          lat: row.lat,
          lon: row.lon,
          articleCount: row.articleCount,
          mentions: row.mentions,
          dominant: row.dominant,
          ...row.categories,
          latestMs: row.latestMs,
          topArticle: row.events[0]?.url ?? null,
        });
      }
      return result;
    },

    getRowControls() {
      const rows = [..._rowById.values()];
      return {
        chips: [],
        legend: NEWS_EVENT_CATEGORIES.map((category, index) => ({
          label: newsEventCategoryLabel(category),
          color: NEWS_EVENT_COLORS[category],
          count: rows.filter((row) => row.dominant === category).length,
          ...(index === 0
            ? {
                blurb: t(
                  'GDELT codes news articles into events and places them from the text. Colour shows the most frequent kind per place; size shows article count.',
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
