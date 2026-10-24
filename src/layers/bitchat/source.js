import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { parseCells } from './records.js';

/** Acquire only the anonymous, spatially capped same-origin API. */
export function createBitchatSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function get(path, signal) {
    const response = await fetchImpl(`/api/bitchat/${path}`, { signal });
    if (!response.ok)
      throw new Error(`Bitchat feed unavailable (HTTP ${response.status})`);
    return readResponseJsonCapped(response, 4 * 1024 * 1024, signal);
  }
  return {
    async getSnapshot({ precision = 2 } = {}, { signal } = {}) {
      return parseCells(
        await get(
          `cells?precision=${Math.min(4, Math.max(2, Math.floor(precision)))}`,
          signal,
        ),
      );
    },
    async getMessages(cell, { signal } = {}) {
      if (!/^[0123456789bcdefghjkmnpqrstuvwxyz]{2,4}$/.test(cell))
        throw new Error('Invalid Bitchat cell');
      const data = await get(`messages?cell=${cell}`, signal);
      if (
        data.cell !== cell ||
        !Number.isInteger(data.people) ||
        !Array.isArray(data.messages)
      )
        throw new Error('Malformed Bitchat messages');
      return {
        cell,
        people: data.people,
        messages: data.messages
          .slice(0, 20)
          .filter(
            (row) => typeof row?.text === 'string' && Number.isFinite(row.at),
          )
          .map(({ text, at }) => ({ text: text.slice(0, 280), at })),
      };
    },
  };
}
