import { admitSameSite } from './common/same-site.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { createRelayPool } from './bitchat/pool.js';
import {
  aggregateCells,
  readMessages,
  PRESENCE_WINDOW_S,
  CHAT_WINDOW_S,
} from './bitchat/store.js';

/** Same-site anonymous Bitchat routes shared by dev and preview servers. */
export function bitchatProxy({
  pool = createRelayPool(),
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60000, max: 120, globalMax: 1200 });
  const handler = (req, res) => {
    if (admitSameSite(req, res)) return;
    const json = (code, value) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(code === 405 ? { Allow: 'GET' } : {}),
        ...(code === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url, 'http://localhost');
    if (!['/cells', '/messages'].includes(url.pathname))
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const cell = url.searchParams.get('cell');
    if (
      url.pathname === '/messages' &&
      !/^[0123456789bcdefghjkmnpqrstuvwxyz]{2,4}$/.test(cell || '')
    )
      return json(400, { error: 'invalid_cell' });
    pool.touch();
    pool.store.prune(now());
    if (url.pathname === '/messages')
      return json(200, readMessages(pool.store, cell, now()));
    json(200, {
      ...pool.snapshot(),
      presenceWindowS: PRESENCE_WINDOW_S,
      chatWindowS: CHAT_WINDOW_S,
      generatedAt: now(),
      ...aggregateCells(pool.store, {
        precision: url.searchParams.get('precision') ?? 2,
        now: now(),
      }),
    });
  };
  const install = (server) => {
    server.middlewares.use('/api/bitchat', handler);
    server.httpServer?.on('close', pool.dispose);
  };
  return {
    name: 'bitchat',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle: pool.dispose,
  };
}
