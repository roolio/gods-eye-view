const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const HASH = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,4}$/;

/** Decode a public aggregate geohash into degree bounds. */
export function geohashBounds(geohash) {
  if (typeof geohash !== 'string' || !HASH.test(geohash)) return null;
  const lon = [-180, 180],
    lat = [-90, 90];
  let bitIndex = 0;
  for (const character of geohash) {
    const value = BASE32.indexOf(character);
    for (let bit = 4; bit >= 0; bit--) {
      const range = bitIndex++ % 2 === 0 ? lon : lat;
      range[value & (1 << bit) ? 0 : 1] = (range[0] + range[1]) / 2;
    }
  }
  return { west: lon[0], south: lat[0], east: lon[1], north: lat[1] };
}

/** Choose the server's privacy-capped precision for the camera height in metres. */
export function precisionForHeight(height) {
  return height > 8000000 ? 2 : height > 2000000 ? 3 : 4;
}

/** Validate aggregate response fields and discard any unrecognized wire fields. */
export function parseCells(payload) {
  if (
    !payload ||
    !['warming', 'live', 'degraded', 'down'].includes(payload.status) ||
    ![2, 3, 4].includes(payload.precision) ||
    !Array.isArray(payload.cells) ||
    !Array.isArray(payload.coarse) ||
    !Number.isFinite(payload.generatedAt)
  )
    throw new Error('Malformed Bitchat snapshot');
  const count = (n) => Number.isInteger(n) && n >= 0;
  const valid = (row, coarse) =>
    row &&
    typeof row.geohash === 'string' &&
    HASH.test(row.geohash) &&
    (coarse
      ? row.geohash.length < payload.precision
      : row.geohash.length === payload.precision) &&
    count(row.people) &&
    row.people >= 3;
  if (
    !count(payload.relays?.listed) ||
    !count(payload.relays?.open) ||
    payload.relays.open > payload.relays.listed
  )
    throw new Error('Malformed Bitchat relay status');
  const cells = payload.cells
    .filter(
      (row) =>
        valid(row, false) && count(row.messages) && Number.isFinite(row.lastAt),
    )
    .map(({ geohash, people, messages, lastAt }) => ({
      geohash,
      people,
      messages,
      lastAt,
    }));
  const coarse = payload.coarse
    .filter((row) => valid(row, true))
    .map(({ geohash, people }) => ({ geohash, people }));
  return {
    status: payload.status,
    precision: payload.precision,
    generatedAt: payload.generatedAt,
    relays: { listed: payload.relays.listed, open: payload.relays.open },
    cells,
    coarse,
  };
}
