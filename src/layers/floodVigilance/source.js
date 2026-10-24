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

const reading = (value) =>
  value &&
  Number.isFinite(value.value) &&
  Number.isFinite(value.observedAt) &&
  (value.method === null || typeof value.method === 'string') &&
  (value.qualification === null || typeof value.qualification === 'string');

/** Keep only well-formed stations from the proxy's tile join. */
function parseStations(payload) {
  if (!Array.isArray(payload?.stations))
    throw new Error(msg("Malformed Hub'Eau response"));
  return {
    stations: payload.stations
      .filter(
        (station) =>
          typeof station?.id === 'string' &&
          typeof station.name === 'string' &&
          Number.isFinite(station.lon) &&
          Number.isFinite(station.lat),
      )
      .map((station) => ({
        id: station.id,
        name: station.name,
        river: typeof station.river === 'string' ? station.river : null,
        lon: station.lon,
        lat: station.lat,
        height: reading(station.height) ? station.height : null,
        flow: reading(station.flow) ? station.flow : null,
        trend: ['rising', 'falling', 'steady'].includes(
          station.trend?.direction,
        )
          ? station.trend
          : null,
      })),
    partial: payload.partial === true,
    stale: payload.stale === true,
  };
}

/**
 * Same-origin flood vigilance feeds: the Vigicrues bulletin through
 * `/api/flood-vigilance/sections`, Hub'Eau gauging stations for a view
 * through `/api/flood-vigilance/stations`.
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createFloodVigilanceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    label: "Vigicrues · Hub'Eau", // i18n-ignore: data provider names
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
    /**
     * @param {{west: number, south: number, east: number, north: number}} bbox
     *   Degrees; the proxy snaps it to whole-degree tiles.
     */
    async getStations(bbox, { signal } = {}) {
      signal?.throwIfAborted();
      const query = new URLSearchParams(
        ['west', 'south', 'east', 'north'].map((key) => [
          key,
          bbox[key].toFixed(3),
        ]),
      );
      const response = await fetchImpl(
        `/api/flood-vigilance/stations?${query}`,
        { signal },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw sourceError("Hub'Eau", response);
      }
      const payload = await readResponseJsonCapped(response, 8 * MIB, signal);
      signal?.throwIfAborted();
      return parseStations(payload);
    },
  };
}
