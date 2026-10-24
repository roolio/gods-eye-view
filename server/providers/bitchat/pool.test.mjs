import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayPool } from './pool.js';
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('lazy pool caps connecting sockets, deduplicates events and disposes all state on idle', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1800000000;
  const sockets = [];
  const pool = createRelayPool({
    now: () => now,
    getRelays: async () =>
      Array.from({ length: 40 }, (_, i) => `wss://relay${i}.test`),
    createSocket(url) {
      const socket = {
        url,
        sent: [],
        closed: false,
        send(text) {
          this.sent.push(JSON.parse(text));
        },
        close() {
          this.closed = true;
        },
      };
      sockets.push(socket);
      return socket;
    },
  });
  assert.equal(sockets.length, 0);
  pool.touch();
  await flush();
  assert.equal(sockets.length, 32);
  for (const socket of sockets) socket.onopen();
  assert.deepEqual(sockets[0].sent[0], [
    'REQ',
    'bitchat',
    { kinds: [20000], since: now - 3600, limit: 500 },
    { kinds: [20001], since: now - 300, limit: 500 },
  ]);
  const frame = JSON.stringify([
    'EVENT',
    'bitchat',
    {
      id: 'b'.repeat(64),
      pubkey: 'a'.repeat(64),
      kind: 20000,
      content: 'test',
      created_at: now,
      tags: [['g', 'u09t']],
    },
  ]);
  sockets[0].onmessage({ data: frame });
  sockets[1].onmessage({ data: frame });
  assert.equal(pool.store.chat.get('u09t').length, 1);
  now += 61;
  t.mock.timers.tick(1000);
  assert.deepEqual(pool.snapshot(), {
    status: 'live',
    relays: { listed: 40, open: 32 },
  });
  assert.equal(sockets.length, 40);
  now += 540;
  t.mock.timers.tick(1000);
  assert.equal(
    sockets.every((s) => s.closed),
    true,
  );
  assert.equal(pool.store.presence.size, 0);
  assert.equal(pool.store.chat.size, 0);
  pool.touch();
  await flush();
  assert.equal(sockets.length, 72);
  pool.dispose();
});

test('timeouts and failures retry with backoff without stale callbacks reentering', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1800000000;
  const sockets = [];
  const pool = createRelayPool({
    now: () => now,
    getRelays: async () => ['wss://relay.test'],
    createSocket() {
      const s = { close() {}, send() {} };
      sockets.push(s);
      return s;
    },
  });
  pool.touch();
  await flush();
  const lateOpen = sockets[0].onopen;
  now += 16;
  t.mock.timers.tick(1000);
  lateOpen();
  assert.equal(pool.snapshot().relays.open, 0);
  now += 14;
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 1);
  now++;
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  sockets[1].onerror();
  now += 60;
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 3);
  pool.dispose();
});
