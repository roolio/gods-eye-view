/**
 * GDELT 2.0 Events records. Pure and Cesium-free: the server proxy parses and
 * aggregates with these, and the browser source validates the result.
 *
 * GDELT machine-codes news articles into CAMEO events and geocodes them from
 * the article text, so a row is a media report of an event at a place, not a
 * verified incident. Only conflict and unrest (QuadClass 3 and 4) with a
 * city-level location are kept: country- and state-level rows sit on
 * centroids and would pile up in the middle of every country.
 */

/** 0-based columns of the 61-column Events 2.0 export this layer reads. */
const COLUMN = Object.freeze({
  id: 0,
  actor1: 6,
  actor2: 16,
  isRoot: 25,
  eventCode: 26,
  rootCode: 28,
  quadClass: 29,
  goldstein: 30,
  mentions: 31,
  sources: 32,
  articles: 33,
  tone: 34,
  geoType: 51,
  geoName: 52,
  geoCountry: 53,
  lat: 56,
  lon: 57,
  featureId: 58,
  dateAdded: 59,
  url: 60,
});
const EXPORT_COLUMNS = 61;

/** City-level ActionGeo types: 3 = US city or landmark, 4 = world city or landmark. */
const CITY_GEO_TYPES = new Set(['3', '4']);

/** Display categories, most severe first (ties in a location resolve in this order). */
export const NEWS_EVENT_CATEGORIES = Object.freeze([
  'violence',
  'protest',
  'coercion',
  'tension',
]);

/** CAMEO root code (10-20) to display category. */
const CATEGORY_BY_ROOT = Object.freeze({
  10: 'tension', // demand
  11: 'tension', // disapprove
  12: 'tension', // reject
  13: 'tension', // threaten
  14: 'protest',
  15: 'coercion', // exhibit force posture
  16: 'coercion', // reduce relations
  17: 'coercion', // coerce
  18: 'violence', // assault
  19: 'violence', // fight
  20: 'violence', // unconventional mass violence
});

/** Events kept per location for the card and the analyst records. */
export const NEWS_EVENTS_PER_LOCATION = 5;
/** Locations kept per snapshot, by distinct article count. */
export const NEWS_EVENT_LOCATION_LIMIT = 3000;

const finite = (value) => {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** GDELT `DATEADDED` (YYYYMMDDHHMMSS, UTC) to epoch ms, or null. */
export function gdeltStampToMs(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    String(stamp ?? ''),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  // Reject compact dates that do not name a real instant (e.g. month 13).
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms;
}

/**
 * GDELT actor names arrive upper-case; title-case them, but keep two-letter
 * words upper-case: in actor names they are codes (US, UK, UN, EU).
 */
function actorName(value) {
  const name = String(value ?? '').trim();
  if (!name) return null;
  return name
    .toLowerCase()
    .replace(/\b[a-z]+/g, (word) =>
      word.length === 2
        ? word.toUpperCase()
        : word[0].toUpperCase() + word.slice(1),
    )
    .slice(0, 60);
}

function articleUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Parse one Events 2.0 export (tab-separated, no header) into event rows.
 * Malformed or out-of-scope lines are skipped individually: one bad line
 * must never blank a whole 15-minute file.
 * @param {string} text - Decompressed `*.export.CSV` content.
 * @returns {Array<Object>} Conflict/unrest events with city-level locations.
 */
export function parseGdeltEventsExport(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    const cells = line.replace(/\r$/, '').split('\t');
    if (cells.length < EXPORT_COLUMNS) continue;
    const quadClass = cells[COLUMN.quadClass];
    if (quadClass !== '3' && quadClass !== '4') continue;
    if (!CITY_GEO_TYPES.has(cells[COLUMN.geoType])) continue;
    const category = CATEGORY_BY_ROOT[Number(cells[COLUMN.rootCode])];
    if (!category) continue;
    const lat = finite(cells[COLUMN.lat]);
    const lon = finite(cells[COLUMN.lon]);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      continue;
    // 0,0 is GDELT's geocoder failing, not an event in the Gulf of Guinea.
    if (lat === 0 && lon === 0) continue;
    const url = articleUrl(cells[COLUMN.url]);
    const id = cells[COLUMN.id];
    if (!url || !/^\d+$/.test(id)) continue;
    const place = String(cells[COLUMN.geoName] ?? '').trim() || null;
    const featureId = String(cells[COLUMN.featureId] ?? '').trim();
    rows.push({
      id,
      category,
      eventCode: cells[COLUMN.eventCode] || null,
      rootEvent: cells[COLUMN.isRoot] === '1',
      actor1: actorName(cells[COLUMN.actor1]),
      actor2: actorName(cells[COLUMN.actor2]),
      goldstein: finite(cells[COLUMN.goldstein]),
      mentions: finite(cells[COLUMN.mentions]) ?? 0,
      sources: finite(cells[COLUMN.sources]) ?? 0,
      articles: finite(cells[COLUMN.articles]) ?? 0,
      tone: finite(cells[COLUMN.tone]),
      place,
      country: String(cells[COLUMN.geoCountry] ?? '').trim() || null,
      lat,
      lon,
      // The geocoder's feature id names a place; rounded coordinates stand in
      // when it is missing so two unnamed points never merge across a city.
      locationId: featureId || `${lat.toFixed(3)},${lon.toFixed(3)}`,
      timeMs: gdeltStampToMs(cells[COLUMN.dateAdded]),
      url,
    });
  }
  return rows;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Aggregate events into one record per location. Within a location an
 * article coded into several events counts once (its most-mentioned event),
 * so `articleCount` measures coverage rather than GDELT's coding fan-out.
 * @param {Iterable<Object>} events - Rows from parseGdeltEventsExport.
 * @param {{limit?: number}} [options]
 * @returns {Array<Object>} Locations, most-covered first.
 */
export function aggregateNewsEvents(
  events,
  { limit = NEWS_EVENT_LOCATION_LIMIT } = {},
) {
  /** @type {Map<string, {first: Object, byUrl: Map<string, Object>}>} */
  const groups = new Map();
  for (const event of events) {
    let group = groups.get(event.locationId);
    if (!group) {
      group = { first: event, byUrl: new Map() };
      groups.set(event.locationId, group);
    }
    const previous = group.byUrl.get(event.url);
    if (
      !previous ||
      event.mentions > previous.mentions ||
      (event.mentions === previous.mentions &&
        (event.timeMs ?? 0) > (previous.timeMs ?? 0))
    )
      group.byUrl.set(event.url, event);
  }
  const locations = [];
  for (const [stableId, { first, byUrl }] of groups) {
    const kept = [...byUrl.values()];
    const categories = Object.fromEntries(
      NEWS_EVENT_CATEGORIES.map((category) => [category, 0]),
    );
    let mentions = 0;
    let latestMs = null;
    for (const event of kept) {
      categories[event.category]++;
      mentions += event.mentions;
      if (event.timeMs != null && (latestMs == null || event.timeMs > latestMs))
        latestMs = event.timeMs;
    }
    const dominant = NEWS_EVENT_CATEGORIES.reduce((best, category) =>
      categories[category] > categories[best] ? category : best,
    );
    const top = kept
      .sort(
        (a, b) =>
          b.mentions - a.mentions ||
          (b.timeMs ?? 0) - (a.timeMs ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, NEWS_EVENTS_PER_LOCATION)
      .map((event) => ({
        category: event.category,
        eventCode: event.eventCode,
        actor1: event.actor1,
        actor2: event.actor2,
        mentions: event.mentions,
        tone: event.tone,
        timeMs: event.timeMs,
        url: event.url,
        domain: domainOf(event.url),
      }));
    locations.push({
      stableId,
      place: first.place,
      country: first.country,
      lat: first.lat,
      lon: first.lon,
      articleCount: kept.length,
      mentions,
      categories,
      dominant,
      latestMs,
      events: top,
    });
  }
  return locations
    .sort(
      (a, b) =>
        b.articleCount - a.articleCount ||
        b.mentions - a.mentions ||
        a.stableId.localeCompare(b.stableId),
    )
    .slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * Validate a proxy snapshot's locations, skipping individually invalid rows.
 * Only a payload without a locations array rejects the whole snapshot.
 * @param {Object} payload - `/api/news-events` response body.
 * @returns {Array<Object>|null}
 */
export function normalizeNewsEventsSnapshot(payload) {
  if (!Array.isArray(payload?.locations)) return null;
  const rows = [];
  const ids = new Set();
  for (const row of payload.locations) {
    if (!row || typeof row !== 'object') continue;
    const { stableId, lat, lon, articleCount } = row;
    if (typeof stableId !== 'string' || !stableId || ids.has(stableId))
      continue;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (!Number.isInteger(articleCount) || articleCount < 1) continue;
    if (!NEWS_EVENT_CATEGORIES.includes(row.dominant)) continue;
    ids.add(stableId);
    const categories = Object.fromEntries(
      NEWS_EVENT_CATEGORIES.map((category) => [
        category,
        Number.isInteger(row.categories?.[category])
          ? row.categories[category]
          : 0,
      ]),
    );
    const events = Array.isArray(row.events)
      ? row.events
          .filter(
            (event) =>
              event &&
              NEWS_EVENT_CATEGORIES.includes(event.category) &&
              typeof event.url === 'string' &&
              /^https?:\/\//i.test(event.url),
          )
          .slice(0, NEWS_EVENTS_PER_LOCATION)
      : [];
    rows.push({
      stableId,
      place: typeof row.place === 'string' ? row.place : null,
      country: typeof row.country === 'string' ? row.country : null,
      lat,
      lon,
      articleCount,
      mentions: Number.isFinite(row.mentions) ? row.mentions : 0,
      categories,
      dominant: row.dominant,
      latestMs: Number.isFinite(row.latestMs) ? row.latestMs : null,
      events,
    });
  }
  return rows;
}
