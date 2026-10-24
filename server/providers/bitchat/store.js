import { createHash, randomBytes } from 'node:crypto';

export const PRESENCE_WINDOW_S = 300;
export const CHAT_WINDOW_S = 3600;
export const MIN_PEOPLE = 3;
const salt = randomBytes(32).toString('hex');
const GEOHASH = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/;

/** Reduce an untrusted Nostr event to anonymous, bounded observations. */
export function parseEvent(event, now) {
  if (!event || ![20000, 20001].includes(event.kind)) return null;
  if (!/^[a-f0-9]{64}$/i.test(event.pubkey)) return null;
  if (
    !Number.isInteger(event.created_at) ||
    event.created_at < now - CHAT_WINDOW_S ||
    event.created_at > now + 60
  )
    return null;
  if (!Array.isArray(event.tags) || typeof event.content !== 'string')
    return null;
  const geohash = event.tags.find(
    (tag) => Array.isArray(tag) && tag[0] === 'g',
  )?.[1];
  if (typeof geohash !== 'string' || !GEOHASH.test(geohash)) return null;
  const text =
    event.kind === 20000
      ? event.content
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
          .trim()
          .slice(0, 280)
      : '';
  const kind = text ? 'chat' : 'presence';
  if (kind === 'presence' && event.created_at < now - PRESENCE_WINDOW_S)
    return null;
  return {
    actor: createHash('sha256')
      .update(salt + event.pubkey.toLowerCase())
      .digest('hex')
      .slice(0, 16),
    geohash,
    level: geohash.length,
    at: event.created_at,
    kind,
    ...(text ? { text } : {}),
  };
}

/** Own the rolling maps. Raw keys, nicknames and wire events never enter them. */
export function createStore() {
  const presence = new Map();
  const chat = new Map();
  return {
    presence,
    chat,
    add(observation, now) {
      const { geohash, actor, at, kind, text } = observation;
      if (at >= now - PRESENCE_WINDOW_S) {
        if (!presence.has(geohash)) presence.set(geohash, new Map());
        const actors = presence.get(geohash);
        actors.set(actor, Math.max(at, actors.get(actor) ?? -Infinity));
      }
      if (kind === 'chat' && at >= now - CHAT_WINDOW_S) {
        const rows = chat.get(geohash) || [];
        rows.push({ text, at, actor });
        rows.sort((a, b) => b.at - a.at);
        chat.set(geohash, rows.slice(0, 50));
      }
    },
    prune(now) {
      for (const [g, actors] of presence) {
        for (const [actor, at] of actors)
          if (at < now - PRESENCE_WINDOW_S) actors.delete(actor);
        if (!actors.size) presence.delete(g);
      }
      for (const [g, rows] of chat) {
        const recent = rows.filter(({ at }) => at >= now - CHAT_WINDOW_S);
        if (recent.length) chat.set(g, recent);
        else chat.delete(g);
      }
    },
    clear() {
      presence.clear();
      chat.clear();
    },
  };
}

/** Limit public spatial resolution to geohash lengths two through four. */
export function clampPrecision(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(4, Math.max(2, Math.floor(number)))
    : 2;
}

/** Aggregate already-pruned maps without summing independently keyed levels. */
export function aggregateCells(store, { precision = 2, now }) {
  const p = clampPrecision(precision);
  const groups = new Map();
  function include(g, actor, at, message) {
    const key = g.slice(0, p);
    if (!groups.has(key))
      groups.set(key, { levels: new Map(), messages: 0, lastAt: 0 });
    const cell = groups.get(key);
    if (!cell.levels.has(g.length)) cell.levels.set(g.length, new Set());
    cell.levels.get(g.length).add(actor);
    cell.messages += message ? 1 : 0;
    cell.lastAt = Math.max(cell.lastAt, at);
  }
  for (const [g, actors] of store.presence)
    for (const [actor, at] of actors)
      if (at >= now - PRESENCE_WINDOW_S) include(g, actor, at, false);
  for (const [g, rows] of store.chat)
    for (const row of rows)
      if (row.at >= now - CHAT_WINDOW_S) include(g, row.actor, row.at, true);
  const cells = [],
    coarse = [];
  for (const [geohash, group] of groups) {
    const people = Math.max(
      ...Array.from(group.levels.values(), (actors) => actors.size),
    );
    if (people < MIN_PEOPLE) continue;
    if (geohash.length < p) coarse.push({ geohash, people });
    else
      cells.push({
        geohash,
        people,
        messages: group.messages,
        lastAt: group.lastAt,
      });
  }
  cells.sort((a, b) => a.geohash.localeCompare(b.geohash));
  coarse.sort((a, b) => a.geohash.localeCompare(b.geohash));
  return { precision: p, cells, coarse };
}

/** Return only anonymous text for cells passing the same aggregation threshold. */
export function readMessages(store, cell, now) {
  store.prune(now);
  const people =
    aggregateCells(store, { precision: cell.length, now }).cells.find(
      ({ geohash }) => geohash === cell,
    )?.people || 0;
  if (people < MIN_PEOPLE) return { cell, people: 0, messages: [] };
  const messages = [];
  for (const [g, rows] of store.chat)
    if (g.startsWith(cell)) messages.push(...rows);
  return {
    cell,
    people,
    messages: messages
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map(({ text, at }) => ({ text, at })),
  };
}
