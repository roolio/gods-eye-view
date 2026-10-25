import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  newsEventsProxy,
  unzipSingleEntry,
} from '../../server/providers/newsEvents.js';

/** A one-entry zip the way GDELT publishes exports (deflate, no descriptor). */
function zip(name, text) {
  const data = deflateRawSync(Buffer.from(text));
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(text), 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(text), 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + fileName.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return new Uint8Array(
    Buffer.concat([local, fileName, data, central, fileName, end]),
  );
}

function line(id, url, featureId = '-1456928') {
  const cells = Array(61).fill('');
  Object.assign(cells, {
    0: id,
    25: '1',
    26: '140',
    28: '14',
    29: '3',
    31: '1',
    51: '4',
    52: 'Paris, Ile-de-France, France',
    56: '48.8667',
    57: '2.3333',
    58: featureId,
    59: '20261025080000',
    60: url,
  });
  return cells.join('\t');
}

function install(options) {
  let handler;
  const plugin = newsEventsProxy(options);
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/news-events');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: 'local' } }, res);
    return res;
  };
}

/** Fake GDELT: `latest` names the newest slot; `files` maps stamps to TSV. */
function gdelt(state) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(url);
    assert.equal(init.redirect, 'error');
    assert.ok(url.startsWith('https://data.gdeltproject.org/gdeltv2/'));
    if (state.down) throw new Error('offline');
    if (url.endsWith('lastupdate.txt'))
      return new Response(
        `1 x http://data.gdeltproject.org/gdeltv2/${state.latest}.export.CSV.zip\n`,
      );
    const stamp = /(\d{14})\.export\.CSV\.zip$/.exec(url)?.[1];
    if (state.fail?.has(stamp)) return new Response('', { status: 500 });
    if (!(stamp in state.files)) return new Response('', { status: 404 });
    return new Response(zip(`${stamp}.export.CSV`, state.files[stamp]));
  };
  return { fetchImpl, requests };
}

test('unzipSingleEntry reads deflated and stored entries and rejects junk', () => {
  assert.equal(unzipSingleEntry(zip('a.csv', 'hello\tworld')), 'hello\tworld');
  assert.throws(() => unzipSingleEntry(new Uint8Array(64)), /invalid_zip/);
});

test('a refresh fills the 24 h window once, then downloads only new slots', async () => {
  let clock = 0;
  const state = {
    latest: '20261025080000',
    files: {
      20261025080000: line('1', 'https://a.example/1'),
      20261025074500: [
        line('2', 'https://a.example/2'),
        line('3', 'https://a.example/2'), // same article, second coding
      ].join('\n'),
    },
    fail: new Set(['20261025073000']),
  };
  const { fetchImpl, requests } = gdelt(state);
  const get = install({ fetchImpl, now: () => clock });

  const first = await get();
  assert.equal(first.status, 200);
  assert.equal(first.body.latestSlot, '20261025080000');
  // 96 slots in the window; one transient failure is retried, 404s are empty.
  assert.deepEqual(first.body.slots, { expected: 96, loaded: 95, failed: 1 });
  assert.equal(requests.length, 1 + 96);
  assert.equal(first.body.locations.length, 1);
  assert.equal(first.body.locations[0].articleCount, 2);

  // Within the TTL the snapshot is served without touching GDELT.
  await get();
  assert.equal(requests.length, 97);

  clock += 5 * 60_000;
  state.latest = '20261025081500';
  state.files['20261025081500'] = line('4', 'https://a.example/3');
  state.fail.clear();
  requests.length = 0;
  const second = await get();
  // lastupdate, the new slot, and the slot that failed last time.
  assert.deepEqual(
    requests.map((url) => url.split('/').pop()),
    [
      'lastupdate.txt',
      '20261025081500.export.CSV.zip',
      '20261025073000.export.CSV.zip',
    ],
  );
  assert.deepEqual(second.body.slots, { expected: 96, loaded: 96, failed: 0 });
  assert.equal(second.body.locations[0].articleCount, 3);
});

test('an upstream outage serves the last snapshot as stale, or 502 without one', async () => {
  let clock = 0;
  const state = {
    latest: '20261025080000',
    files: { 20261025080000: line('1', 'https://a.example/1') },
  };
  const { fetchImpl } = gdelt(state);
  const get = install({ fetchImpl, now: () => clock });
  await get();
  clock += 10 * 60_000;
  state.down = true;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.locations.length, 1);

  const cold = install({ fetchImpl, now: () => 0 });
  const failed = await cold();
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'news_events_unavailable' });
});

test('only GET on the root route is served', async () => {
  const { fetchImpl, requests } = gdelt({
    latest: '20261025080000',
    files: {},
  });
  const get = install({ fetchImpl });
  assert.equal((await get('/', 'POST')).status, 405);
  assert.equal((await get('/other')).status, 404);
  assert.equal(requests.length, 0);
});
