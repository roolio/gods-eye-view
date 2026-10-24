import { normalizeVigicruesSnapshot } from '../../src/layers/floodVigilance/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Vigicrues national flood bulletin (keyless, Licence Ouverte). It is
// published at 10:00 and 16:00 local time plus exceptional updates; the raw
// collection is ~2.2 MB, so the proxy simplifies it once per refresh.
const VIGICRUES_URL =
  'https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson';
const SECTIONS_TTL_MS = 10 * 60_000;
/** A failed refresh keeps serving the last bulletin for this long. */
const SECTIONS_STALE_MAX_MS = 24 * 3600_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MIB = 1024 * 1024;
const USER_AGENT = 'gods-eye-view-flood-vigilance/1.0';

/** Fixed-origin, bounded Vigicrues route for dev and preview. */
export function floodVigilanceProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  let sections = null;
  let sectionsFailedAt = -Infinity;

  async function upstreamJson(url, maxBytes, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, maxBytes, signal);
  }

  async function loadSections() {
    const payload = await upstreamJson(VIGICRUES_URL, 16 * MIB, 30_000);
    const snapshot = normalizeVigicruesSnapshot(payload);
    if (!snapshot?.sections.length) throw new Error('invalid_snapshot');
    return { fetchedAt: now(), ...snapshot };
  }

  async function acquireSections() {
    const age = sections ? now() - sections.fetchedAt : Infinity;
    if (age >= 0 && age < SECTIONS_TTL_MS)
      return { value: sections, stale: false };
    try {
      if (now() - sectionsFailedAt < FAILURE_COOLDOWN_MS)
        throw new Error('cooling_down');
      const { promise } = coalesceProxyRequest(inFlight, 'sections', () =>
        loadSections(),
      );
      sections = await promise;
      return { value: sections, stale: false };
    } catch (error) {
      if (error.message !== 'cooling_down') sectionsFailedAt = now();
      if (sections && now() - sections.fetchedAt < SECTIONS_STALE_MAX_MS)
        return { value: sections, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(status === 502 ? { 'Retry-After': '30' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/sections') return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquireSections();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'flood_vigilance_unavailable' });
    }
  }

  return {
    name: 'flood-vigilance',
    configureServer({ middlewares }) {
      middlewares.use('/api/flood-vigilance', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/flood-vigilance', handler);
    },
  };
}
