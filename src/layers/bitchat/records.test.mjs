import test from 'node:test';
import assert from 'node:assert/strict';
import { geohashBounds, parseCells, precisionForHeight } from './records.js';
import { createBitchatSource } from './source.js';
const payload = {
  status: 'live',
  precision: 3,
  generatedAt: 1000,
  relays: { listed: 377, open: 300 },
  cells: [
    { geohash: 'u09', people: 3, messages: 4, lastAt: 999, actor: 'private' },
  ],
  coarse: [{ geohash: 'u0', people: 4 }],
};

test('u09 bounds enclose Paris using literal decoded degree limits', () => {
  assert.deepEqual(geohashBounds('u09'), {
    west: 1.40625,
    south: 47.8125,
    east: 2.8125,
    north: 49.21875,
  });
  assert.equal(geohashBounds('u09tq'), null);
  assert.deepEqual(
    [
      precisionForHeight(9000000),
      precisionForHeight(3000000),
      precisionForHeight(2000000),
      precisionForHeight(0),
    ],
    [2, 3, 4, 4],
  );
});

test('response parsing strips extras and refuses malformed aggregates', () => {
  assert.deepEqual(parseCells(payload), {
    status: 'live',
    precision: 3,
    generatedAt: 1000,
    relays: { listed: 377, open: 300 },
    cells: [{ geohash: 'u09', people: 3, messages: 4, lastAt: 999 }],
    coarse: [{ geohash: 'u0', people: 4 }],
  });
  assert.deepEqual(
    parseCells({
      ...payload,
      cells: [{ geohash: 'u09', people: 2, messages: 4, lastAt: 999 }],
    }).cells,
    [],
  );
  assert.throws(
    () => parseCells({ ...payload, status: 'unknown' }),
    /Malformed/,
  );
  assert.throws(() => parseCells({ ...payload, precision: 5 }), /Malformed/);
});

test('source requests only capped cells and returns anonymous text fields', async () => {
  const urls = [];
  const source = createBitchatSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify(
          url.includes('messages')
            ? {
                cell: 'u09',
                people: 3,
                messages: [
                  { text: '<script>hello</script>', at: 999, actor: 'secret' },
                ],
              }
            : payload,
        ),
      );
    },
  });
  assert.equal((await source.getSnapshot({ precision: 6 })).cells[0].people, 3);
  assert.deepEqual(await source.getMessages('u09'), {
    cell: 'u09',
    people: 3,
    messages: [{ text: '<script>hello</script>', at: 999 }],
  });
  assert.deepEqual(urls, [
    '/api/bitchat/cells?precision=4',
    '/api/bitchat/messages?cell=u09',
  ]);
  await assert.rejects(() => source.getMessages('u09tv'), /Invalid/);
});
