import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeNewsEventsSnapshot } from './records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Request a normalized snapshot through the bounded, same-origin GDELT proxy. */
export function createGdeltNewsEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/news-events', { signal });
      if (!response.ok) throw new Error(`GDELT HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        16 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const rows = normalizeNewsEventsSnapshot(payload);
      if (!rows) throw new Error(msg('Malformed news events snapshot'));
      return rows;
    },
  };
}
