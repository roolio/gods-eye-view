import { createStore, parseEvent } from './store.js';

const RELAY_CSV =
  'https://raw.githubusercontent.com/permissionlesstech/georelays/refs/heads/main/nostr_relays.csv';
const FALLBACK = [
  'relay.damus.io',
  'nos.lol',
  'relay.primal.net',
  'offchain.pub',
].map((host) => `wss://${host}`);
let relayList;

async function loadRelays() {
  if (!relayList)
    relayList = (async () => {
      try {
        const response = await fetch(RELAY_CSV, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('relay list unavailable');
        const text = await response.text();
        if (text.length > 256000) throw new Error('relay list too large');
        const hosts = text
          .split('\n')
          .slice(1)
          .map((line) => line.split(',')[0].trim())
          .filter((host) => /^[a-z0-9.-]+(?::\d+)?$/i.test(host));
        if (!hosts.length) throw new Error('empty relay list');
        return [...new Set(hosts)]
          .slice(0, 1000)
          .map((host) => `wss://${host}`);
      } catch {
        return FALLBACK;
      }
    })();
  return relayList;
}

/** Lazy relay pool with one generation owning all sockets, retries and memory. */
export function createRelayPool({
  now = () => Math.floor(Date.now() / 1000),
  getRelays = loadRelays,
  createSocket = (url) => new WebSocket(url),
} = {}) {
  const store = createStore();
  const seen = new Map();
  let generation = 0,
    startedAt = null,
    lastRequest = 0,
    timer = null,
    relays = [];
  function dispose() {
    generation++;
    clearInterval(timer);
    timer = null;
    for (const relay of relays) {
      if (relay.socket) {
        relay.socket.onopen =
          relay.socket.onclose =
          relay.socket.onerror =
          relay.socket.onmessage =
            null;
        try {
          relay.socket.close();
        } catch {
          /* A connecting socket can already be closed. */
        }
      }
    }
    relays = [];
    startedAt = null;
    seen.clear();
    store.clear();
  }
  function tick() {
    const at = now();
    if (at - lastRequest >= 600) {
      dispose();
      return;
    }
    store.prune(at);
    for (const [id, time] of seen) if (time < at - 3600) seen.delete(id);
    let connecting = relays.filter((r) => r.state === 'connecting').length;
    for (const relay of relays) {
      if (
        relay.socket &&
        ((relay.state === 'connecting' && at - relay.since > 15) ||
          (relay.state === 'open' && at - relay.lastFrame > 300))
      ) {
        relay.fail();
      }
      if (connecting >= 32 || relay.socket || relay.nextAt > at) continue;
      connecting++;
      connect(relay);
    }
  }
  function connect(relay) {
    const gen = generation;
    relay.state = 'connecting';
    relay.since = now();
    let socket;
    const fail = () => {
      if (gen !== generation || relay.socket !== socket) return;
      relay.socket = null;
      relay.state = 'closed';
      relay.nextAt = now() + [15, 60, 300][Math.min(2, relay.failures++)];
      if (socket) {
        socket.onopen =
          socket.onclose =
          socket.onerror =
          socket.onmessage =
            null;
        try {
          socket.close();
        } catch {
          /* A failed transport has nothing left to close. */
        }
      }
    };
    relay.fail = fail;
    try {
      socket = createSocket(relay.url);
      relay.socket = socket;
      socket.onopen = () => {
        if (gen !== generation || relay.socket !== socket) return;
        relay.state = 'open';
        relay.lastFrame = now();
        try {
          socket.send(
            JSON.stringify([
              'REQ',
              'bitchat',
              { kinds: [20000], since: now() - 3600, limit: 500 },
              { kinds: [20001], since: now() - 300, limit: 500 },
            ]),
          );
        } catch {
          fail();
        }
      };
      socket.onclose = socket.onerror = fail;
      socket.onmessage = ({ data }) => {
        if (
          gen !== generation ||
          relay.socket !== socket ||
          typeof data !== 'string' ||
          data.length > 65536
        )
          return;
        relay.lastFrame = now();
        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        if (
          !Array.isArray(frame) ||
          frame[0] !== 'EVENT' ||
          frame[1] !== 'bitchat'
        )
          return;
        const event = frame[2];
        if (!/^[a-f0-9]{64}$/i.test(event?.id) || seen.has(event.id)) return;
        const observation = parseEvent(event, now());
        if (!observation) return;
        seen.set(event.id, now());
        if (seen.size > 100000) seen.delete(seen.keys().next().value);
        store.add(observation, now());
      };
    } catch {
      relay.socket = socket;
      fail();
    }
  }
  return {
    store,
    dispose,
    touch() {
      lastRequest = now();
      if (startedAt !== null) return;
      startedAt = now();
      const gen = ++generation;
      timer = setInterval(tick, 1000);
      timer.unref?.();
      void getRelays()
        .then((urls) => {
          if (gen !== generation) return;
          relays = urls.map((url) => ({
            url,
            socket: null,
            state: 'closed',
            nextAt: 0,
            failures: 0,
          }));
          tick();
        })
        .catch(() => {});
    },
    snapshot() {
      store.prune(now());
      const open = relays.filter((r) => r.state === 'open').length;
      return {
        status:
          startedAt !== null && now() - startedAt < 60
            ? 'warming'
            : !open
              ? 'down'
              : open >= relays.length * 0.25
                ? 'live'
                : 'degraded',
        relays: { listed: relays.length, open },
      };
    },
  };
}
