import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  parseEvent,
  aggregateCells,
  readMessages,
} from './store.js';
import { bitchatProxy } from '../bitchat.js';
const now = 1800000000;
const event = (overrides = {}) => ({
  kind: 20000,
  pubkey: 'a'.repeat(64),
  created_at: now,
  content: ' hello\u0000 ',
  tags: [
    ['g', 'u09t'],
    ['n', 'secret nickname'],
  ],
  ...overrides,
});
const add = (store, g, actor, kind = 'presence', at = now) =>
  store.add(
    {
      geohash: g,
      actor,
      kind,
      at,
      ...(kind === 'chat' ? { text: 'hello' } : {}),
    },
    now,
  );

test('max across levels avoids triple counting and keeps coarse cohorts separate', () => {
  const store = createStore();
  for (let i = 0; i < 3; i++) {
    add(store, 'u0', `region${i}`);
    add(store, 'u09t', `province${i}`);
    add(store, 'u09tv', `city${i}`, 'chat');
  }
  assert.deepEqual(aggregateCells(store, { precision: 2, now }), {
    precision: 2,
    cells: [{ geohash: 'u0', people: 3, messages: 3, lastAt: now }],
    coarse: [],
  });
  assert.deepEqual(aggregateCells(store, { precision: 6, now }), {
    precision: 4,
    cells: [{ geohash: 'u09t', people: 3, messages: 3, lastAt: now }],
    coarse: [{ geohash: 'u0', people: 3 }],
  });
  add(store, 'u09tx', 'fourth');
  add(store, 'u09tv', 'city0');
  assert.equal(aggregateCells(store, { precision: 4, now }).cells[0].people, 4);
  assert.equal(aggregateCells(store, { precision: -5, now }).precision, 2);
});

test('sparse cells and sparse coarse entries expose no counts or text', () => {
  const store = createStore();
  add(store, 'u0', 'a');
  add(store, 'u09t', 'a', 'chat');
  add(store, 'u09t', 'b');
  assert.deepEqual(aggregateCells(store, { precision: 4, now }), {
    precision: 4,
    cells: [],
    coarse: [],
  });
  assert.deepEqual(readMessages(store, 'u09t', now), {
    cell: 'u09t',
    people: 0,
    messages: [],
  });
});

test('retention empties both maps and leaves zero texts', () => {
  const store = createStore();
  add(store, 'u09t', 'a', 'chat');
  store.prune(now + 301);
  assert.equal(store.presence.size, 0);
  assert.equal(store.chat.get('u09t')[0].text, 'hello');
  store.prune(now + 3601);
  assert.equal(store.chat.size, 0);
  assert.deepEqual([...store.chat.values()].flat(), []);
});

test('chat cap keeps newest fifty and read keeps newest twenty', () => {
  const store = createStore();
  for (let i = 0; i < 60; i++) add(store, 'u09t', `a${i % 3}`, 'chat', now - i);
  assert.equal(store.chat.get('u09t').length, 50);
  const data = readMessages(store, 'u09', now);
  assert.equal(data.people, 3);
  assert.equal(data.messages.length, 20);
  assert.deepEqual(data.messages[0], { text: 'hello', at: now });
  assert.deepEqual(data.messages[19], { text: 'hello', at: now - 19 });
});

test('event boundary strips identities and rejects invalid timestamps, kinds and geohashes', () => {
  const parsed = parseEvent(event(), now);
  assert.equal(parsed.text, 'hello');
  assert.equal(parsed.kind, 'chat');
  assert.match(parsed.actor, /^[a-f0-9]{16}$/);
  assert.notEqual(parsed.actor, event().pubkey);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'actor',
    'at',
    'geohash',
    'kind',
    'level',
    'text',
  ]);
  assert.equal(JSON.stringify(parsed).includes('secret nickname'), false);
  for (const overrides of [
    { tags: [['g', 'invalid!']] },
    { tags: [] },
    { kind: 1 },
    { created_at: now - 3601 },
    { created_at: now + 61 },
    { pubkey: null },
  ])
    assert.equal(parseEvent(event(overrides), now), null);
  assert.equal(
    parseEvent(
      event({ kind: 20001, content: 'ignored', created_at: now - 301 }),
      now,
    ),
    null,
  );
  assert.equal(
    parseEvent(event({ content: ' '.repeat(20) }), now).kind,
    'presence',
  );
  assert.equal(
    parseEvent(event({ content: 'x'.repeat(1000) }), now).text.length,
    280,
  );
});

function handlerHarness(store) {
  let handler,
    touched = 0;
  const plugin = bitchatProxy({
    now: () => now,
    pool: {
      store,
      touch() {
        touched++;
      },
      snapshot: () => ({ status: 'live', relays: { listed: 4, open: 4 } }),
      dispose() {},
    },
  });
  plugin.configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  return {
    call(url, options = {}) {
      let body;
      const res = {
        setHeader() {},
        writeHead(status) {
          this.statusCode = status;
        },
        end(text) {
          body = JSON.parse(text);
        },
      };
      handler(
        {
          method: 'GET',
          url,
          headers: { host: 'localhost:4173' },
          socket: { remoteAddress: '127.0.0.1' },
          ...options,
        },
        res,
      );
      return { status: res.statusCode, body, touched };
    },
  };
}

test('messages HTTP handler returns exactly text and at only above threshold', () => {
  const store = createStore();
  const h = handlerHarness(store);
  add(store, 'u09t', 'a', 'chat');
  add(store, 'u09t', 'b');
  assert.deepEqual(h.call('/messages?cell=u09t').body, {
    cell: 'u09t',
    people: 0,
    messages: [],
  });
  add(store, 'u09t', 'c');
  assert.deepEqual(h.call('/messages?cell=u09t').body, {
    cell: 'u09t',
    people: 3,
    messages: [{ text: 'hello', at: now }],
  });
  const snapshot = h.call('/cells?precision=6').body;
  assert.equal(snapshot.precision, 4);
  assert.equal(snapshot.cells[0].people, 3);
  assert.equal(h.call('/messages?cell=u09tv').status, 400);
  assert.equal(h.call('/cells', { method: 'POST' }).status, 405);
  const blocked = h.call('/cells', {
    headers: { host: 'localhost:4173', origin: 'https://evil.test' },
  });
  assert.equal(blocked.status, 403);
});
