import { inflateRawSync } from 'node:zlib';

import {
  aggregateNewsEvents,
  parseGdeltEventsExport,
} from '../../src/layers/newsEvents/records.js';
import {
  readResponseBytesCapped,
  readResponseTextCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

/**
 * GDELT 2.0 Events proxy (public, keyless).
 * Upstream: https://data.gdeltproject.org/gdeltv2/lastupdate.txt names the
 * newest 15-minute export; earlier slots follow the same deterministic
 * `YYYYMMDDHHMMSS.export.CSV.zip` naming, so the proxy walks back from it.
 *
 * Each export is parsed once and kept per slot: a refresh only downloads the
 * slots that are new since the last one, and slots that age out of the window
 * are dropped. A slot GDELT never published (404) is remembered as empty;
 * any other failure is retried on the next refresh and reported as partial.
 *
 * Routes:
 *   GET /api/news-events → {fetchedAt, latestSlot, windowHours, slots, stale, locations}
 */

const ORIGIN = 'https://data.gdeltproject.org/gdeltv2/';
const SLOT_MS = 15 * 60_000;
const WINDOW_HOURS = 24;
const WINDOW_SLOTS = (WINDOW_HOURS * 3_600_000) / SLOT_MS;
/** lastupdate.txt changes every 15 minutes; checking more often only re-reads it. */
const REFRESH_TTL_MS = 5 * 60_000;
/** A busy-news export is ~100 KB compressed; this is a bound, not a budget. */
const EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const EXPORT_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;

/** `YYYYMMDDHHMMSS` for a UTC epoch. */
function slotStamp(ms) {
  return new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14);
}

function stampMs(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  return m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : NaN;
}

/**
 * Extract the single file of a GDELT export zip. Reads the central directory
 * (sizes in the local header may be deferred to a data descriptor).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function unzipSingleEntry(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // The end-of-central-directory record sits in the last 22 + 65535 bytes.
  for (
    let i = bytes.byteLength - 22;
    i >= Math.max(0, bytes.byteLength - 65_557);
    i--
  ) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('invalid_zip');
  const central = view.getUint32(eocd + 16, true);
  if (
    central + 46 > bytes.byteLength ||
    view.getUint32(central, true) !== 0x02014b50
  )
    throw new Error('invalid_zip');
  const method = view.getUint16(central + 10, true);
  const compressedSize = view.getUint32(central + 20, true);
  const size = view.getUint32(central + 24, true);
  const local = view.getUint32(central + 42, true);
  if (
    local + 30 > bytes.byteLength ||
    view.getUint32(local, true) !== 0x04034b50
  )
    throw new Error('invalid_zip');
  if (size > EXPORT_MAX_INFLATED_BYTES) throw new Error('export_too_large');
  const start =
    local +
    30 +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  const data = bytes.subarray(start, start + compressedSize);
  if (data.byteLength !== compressedSize) throw new Error('invalid_zip');
  if (method === 0) return Buffer.from(data).toString('utf8');
  if (method !== 8) throw new Error('unsupported_zip');
  return inflateRawSync(data, {
    maxOutputLength: EXPORT_MAX_INFLATED_BYTES,
  }).toString('utf8');
}

/** Fixed-origin, bounded GDELT Events route for dev and preview. */
export function newsEventsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, Array<Object>>} slot stamp → parsed events */
  const slots = new Map();
  const inFlight = new Map();
  /** @type {?{value: Object, savedAt: number}} */
  let snapshot = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function upstream(path, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${ORIGIN}${path}`, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
    });
    return { response, signal };
  }

  async function latestSlot() {
    const { response, signal } = await upstream('lastupdate.txt', 15_000);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const text = await readResponseTextCapped(response, 16 * 1024, signal);
    const stamp = /gdeltv2\/(\d{14})\.export\.CSV\.zip/.exec(text)?.[1];
    if (!stamp || !Number.isFinite(stampMs(stamp)))
      throw new Error('invalid_lastupdate');
    return stamp;
  }

  /** Parsed events for one slot; [] when GDELT never published it. */
  async function loadSlot(stamp) {
    const { response, signal } = await upstream(
      `${stamp}.export.CSV.zip`,
      30_000,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return [];
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const bytes = await readResponseBytesCapped(
      response,
      EXPORT_MAX_BYTES,
      signal,
    );
    return parseGdeltEventsExport(unzipSingleEntry(bytes));
  }

  async function refresh() {
    const latest = await latestSlot();
    const latestMs = stampMs(latest);
    const wanted = Array.from({ length: WINDOW_SLOTS }, (_, index) =>
      slotStamp(latestMs - index * SLOT_MS),
    );
    const wantedSet = new Set(wanted);
    for (const stamp of slots.keys())
      if (!wantedSet.has(stamp)) slots.delete(stamp);
    const missing = wanted.filter((stamp) => !slots.has(stamp));
    let failed = 0;
    // Newest first, a few at a time: a cold start fills the window without
    // opening 96 sockets at once against a public research service.
    for (let i = 0; i < missing.length; i += FETCH_CONCURRENCY) {
      const batch = missing.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(loadSlot));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled')
          slots.set(batch[index], result.value);
        else failed++;
      });
    }
    if (!slots.size) throw new Error('upstream_unavailable');
    const events = [];
    for (const rows of slots.values()) events.push(...rows);
    return {
      fetchedAt: now(),
      latestSlot: latest,
      windowHours: WINDOW_HOURS,
      slots: { expected: WINDOW_SLOTS, loaded: slots.size, failed },
      locations: aggregateNewsEvents(events),
    };
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    if (snapshot && now() - snapshot.savedAt < REFRESH_TTL_MS)
      return json(200, { ...snapshot.value, stale: false });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'events', async () => {
        const value = await refresh();
        snapshot = { value, savedAt: now() };
        return value;
      });
      json(200, { ...(await promise), stale: false });
    } catch {
      if (snapshot) return json(200, { ...snapshot.value, stale: true }, true);
      json(502, { error: 'news_events_unavailable' });
    }
  }

  return {
    name: 'news-events',
    configureServer({ middlewares }) {
      middlewares.use('/api/news-events', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/news-events', handler);
    },
  };
}
