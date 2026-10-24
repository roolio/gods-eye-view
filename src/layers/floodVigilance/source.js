import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { vigilanceLevel } from './records.js';

// A portable export: no i18n here. Failures stay English data; the Layers
// panel shows them translated (ui/statusText.js).
const msg = (text) => text;

const MIB = 1024 * 1024;

function sourceError(name, response) {
  const limited = response.status === 429;
  return Object.assign(
    new Error(
      limited ? `${name} rate limited` : `${name} HTTP ${response.status}`,
    ),
    { status: response.status },
  );
}

/** Keep only well-formed sections from the proxy's compact bulletin. */
function parseSections(payload) {
  if (!Array.isArray(payload?.sections))
    throw new Error(msg('Malformed Vigicrues response'));
  const sections = payload.sections.filter(
    (section) =>
      typeof section?.id === 'string' &&
      typeof section.name === 'string' &&
      vigilanceLevel(section.level) &&
      Array.isArray(section.paths) &&
      section.paths.every(
        (path) =>
          Array.isArray(path) &&
          path.length >= 4 &&
          path.length % 2 === 0 &&
          path.every(Number.isFinite),
      ),
  );
  return {
    sections,
    publishedAt: Number.isFinite(payload.publishedAt)
      ? payload.publishedAt
      : null,
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
    stale: payload.stale === true,
  };
}

/**
 * Same-origin flood vigilance feeds: the Vigicrues bulletin through
 * `/api/flood-vigilance/sections`.
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createFloodVigilanceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    label: 'Vigicrues', // i18n-ignore: data provider name
    async getSections({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/flood-vigilance/sections', {
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw sourceError('Vigicrues', response);
      }
      const payload = await readResponseJsonCapped(response, 8 * MIB, signal);
      signal?.throwIfAborted();
      return parseSections(payload);
    },
  };
}
