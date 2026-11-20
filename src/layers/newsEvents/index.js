import {
  NEWS_EVENTS_OVERLAY_SOURCE_ID,
  NEWS_EVENT_COLORS,
  buildNewsEventCard,
  newsEventCategoryLabel,
} from './cards.js';
import { NEWS_EVENT_CATEGORIES } from './records.js';
import { msg, t } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { drawOf, findFrame, findGlobe } from '../../render/rendererOf.js';
import { inputFor } from '../../input/dispatcher.js';
import { heightsOf } from '../../queries/heights.js';
import { createHorizonCull } from '../streetLevel/view.js';
export * from './records.js';
export * from './cards.js';
export { createGdeltNewsEventsSource } from './source.js';

const PICK_PREFIX = 'news-event:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Marker outline: black at 60 %. */
const OUTLINE_COLOR = Object.freeze([0, 0, 0, 0.6]);

/** Marker size in pixels: grows with coverage, log-scaled so capitals stay legible. */
export function newsEventPixelSize(articleCount) {
  const count = Math.max(1, Number(articleCount) || 1);
  return Math.min(18, 5 + 2 * Math.log2(count));
}

/**
 * A fixed marker position on the ground, never clamped. With Google 3D tiles
 * the globe is hidden, so a clamp samples whatever coarse tile is loaded:
 * markers sank 5 to 150 km under the surface and changed depth with every
 * zoom, and an always-on-top point that deep slides off its place as the
 * camera moves. The terrain height is used only when the globe is drawn.
 */
function markerPosition(viewer, row) {
  const ground =
    viewer && findGlobe(viewer)?.isGlobeVisible?.() === true
      ? heightsOf(viewer).now(
          { lon: row.lon, lat: row.lat },
          { against: 'terrain' },
        )
      : null;
  return fromDegrees(row.lon, row.lat, Number.isFinite(ground) ? ground : 0);
}

/** Own one GDELT news-event display, its refresh lifecycle, and click selection. */
export function createNewsEventsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  openExternal = null,
  // The clicks on the globe: the application's input dispatcher.
  input = (viewer) => inputFor(viewer),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('News events require a snapshot source');
  let _viewer = null;
  let _request = null;
  /** The point set every marker draws in. */
  let _markerSet = null;
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
  /**
   * One per marker, in drawing order: the item as the set draws it, its
   * ECEF position, and whether it is in front of the horizon.
   * @type {Array<{item: Object, position: {x: number, y: number, z: number}, show: boolean}>}
   */
  let _markers = [];

  const requestRender = () => {
    if (_viewer) findFrame(_viewer)?.requestRender?.('news-events');
  };

  /**
   * Hide markers behind the horizon. They skip the depth test and the globe
   * is hidden under Google 3D tiles, so nothing else stops the far side of
   * the planet drawing through it, sliding the wrong way as the camera moves.
   */
  const _horizon = createHorizonCull({
    getViewer: () => _viewer,
    items: () => _markers,
    onChange: (changed) => {
      _markerSet?.upsert(changed.map(syncItem));
      requestRender();
    },
  });

  /** The marker's item with its current `show`. */
  function syncItem(marker) {
    if (marker.item.show !== marker.show)
      marker.item = { ...marker.item, show: marker.show };
    return marker.item;
  }

  const canSelect = () => overlayHost && picking;

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
      position: fromDegrees(row.lon, row.lat),
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

  /** Resolve a pick id to one of this layer's location ids, or null. */
  function pickedLocationId(pickId) {
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
    // A viewer with no renderer input bound takes no clicks.
    let clicks = null;
    try {
      clicks = input(_viewer) ?? null;
    } catch {
      clicks = null;
    }
    if (!clicks) return;
    _clickHandler = clicks.onClick((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      // The card or label painted on top takes the click, read once per
      // click so every layer agrees: ours opens the top article; another
      // layer's is that layer's click, and the selection stays.
      const cardHit = picking.clickCard?.(click) ?? null;
      if (cardHit) {
        if (
          cardHit.sourceId === NEWS_EVENTS_OVERLAY_SOURCE_ID &&
          cardHit.entryId === _selectedCardId &&
          _selectedLink &&
          openExternal
        )
          openExternal(_selectedLink);
        return;
      }
      // A marker's item id is its pick id, `news-event:<id>`, read from what
      // is exactly under the click.
      const picked = click.topHit;
      const pickId = picked ? (picking.resolvePickId(picked) ?? null) : null;
      const locationId = pickedLocationId(pickId);
      if (locationId) {
        _selectedId = locationId;
        publishSelectedCard();
        requestRender();
        return;
      }
      // A pick that belongs to a sibling layer is not "empty space".
      if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
        requestRender();
      }
    });
  }

  function removeClickHandler() {
    _clickHandler?.();
    _clickHandler = null;
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
    name: 'Protests & Crackdowns (24h)',
    icon: '📰',
    source: 'GDELT',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('News events layer is already initialized');
      _viewer = viewer;
      _markerSet = drawOf(viewer).points({
        id: 'news-events:markers',
        show: false,
      });
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:NewsEvents] Initialized');
    },

    enable() {
      _enabled = true;
      if (_markerSet) _markerSet.show = true;
      overlayHost?.setVisible?.(NEWS_EVENTS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      if (_markers.length) _horizon.update();
      requestRender();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_markerSet) _markerSet.show = false;
      _horizon.stop();
      removeClickHandler();
      clearSelection();
      requestRender();
    },

    async update() {
      if (!_enabled || !_markerSet) return false;
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
            show: true,
            item: {
              id: `${PICK_PREFIX}${row.stableId}`,
              pos: position,
              pixelSize: newsEventPixelSize(row.articleCount),
              color: hexColor(NEWS_EVENT_COLORS[row.dominant], 0.85),
              outlineColor: OUTLINE_COLOR,
              outlineWidth: 1,
              // Always on top: a marker hidden behind 3D tiles is a lost report.
              disableDepthTest: Number.POSITIVE_INFINITY,
              show: true,
            },
          };
        });
        _rowById.clear();
        for (const row of rows) _rowById.set(row.stableId, row);
        _markers = nextMarkers;
        // Cull before drawing, so a far-side marker never shows for a frame.
        _horizon.update(nextMarkers, { quiet: true });
        _markerSet.set(nextMarkers.map(syncItem));
        // Refresh (or drop) the selected location's card against the new feed.
        if (_selectedId) publishSelectedCard();
        requestRender();
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

    destroy() {
      _request?.abort();
      _request = null;
      _horizon.stop();
      _markers = [];
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _enabled = false;
      if (_markerSet) {
        _markerSet.dispose();
        _markerSet = null;
      }
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Snapshot location aggregates for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_markerSet || !_markerSet.show) return [];
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
