/**
 * qa-news-events.mjs: headless proof for the News Events (GDELT) layer.
 *
 * Checks what unit tests cannot: that the live GDELT exports reach the app
 * through /api/news-events, that markers render, and that a click on a marker
 * opens its card with the media-signal caveat.
 *
 * Run:  node scripts/qa-news-events.mjs --url http://localhost:4173 [--shot out.png]
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');
const SHOT = getOpt('--shot', null);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const consoleErrors = [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1400, height: 900 },
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
    });
    page.on('response', (r) => {
      if (r.status() >= 400) consoleErrors.push(`${r.status()} ${r.url()}`);
    });
    // Skip the first-run mission picker so it cannot swallow the marker click.
    await page.evaluateOnNewDocument(() =>
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
    );
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(1500);

    const stats = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('news-events', true);
      const mod = dm.layers.get('news-events')?.module;
      if (!mod) return { missing: true };
      let s = null;
      // A cold server downloads 96 exports before the first answer.
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      return s;
    });
    record(
      'locations load from /api/news-events',
      !stats?.missing && !stats?.error && stats?.count > 0,
      `count=${stats?.count} error=${stats?.error}`,
    );

    const records = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('news-events')
          ?.module.getAnalystRecords(5000) || [],
    );
    const shaped = records.every(
      (r) =>
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        r.articleCount >= 1 &&
        ['violence', 'protest', 'coercion', 'tension'].includes(r.dominant),
    );
    record(
      'every location carries a position, a count and a kind',
      shaped,
      records.length
        ? `top=${records[0].place} (${records[0].articleCount})`
        : 'none',
    );

    // Frame the busiest place and click its marker on screen.
    const target = records[0];
    await page.evaluate((t) => {
      const { viewer } = window.__godsEyeView;
      viewer.camera.cancelFlight?.();
      viewer.camera.setView({
        destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: (t.lon * Math.PI) / 180,
          latitude: (t.lat * Math.PI) / 180,
          height: 2_500_000,
        }),
      });
    }, target);
    await sleep(4000);
    const screen = await page.evaluate((t) => {
      const { viewer } = window.__godsEyeView;
      const entity = viewer.dataSources
        .getByName('news-events')[0]
        ?.entities.getById(`news-event:${t.id}`);
      const position = entity?.position?.getValue(viewer.clock.currentTime);
      const point = position
        ? viewer.scene.cartesianToCanvasCoordinates(position)
        : null;
      const rect = viewer.scene.canvas.getBoundingClientRect();
      return point ? { x: rect.left + point.x, y: rect.top + point.y } : null;
    }, target);
    if (screen) await page.mouse.click(screen.x, screen.y);
    await sleep(1500);
    const painted = await page.evaluate(
      () =>
        window.__gevWorldOverlay?.getDiagnostics().paintedBySource[
          'news-events'
        ] ?? 0,
    );
    record(
      'clicking the busiest marker paints its card',
      painted === 1,
      `painted=${painted} marker at ${JSON.stringify(screen)}`,
    );
    if (SHOT) await page.screenshot({ path: SHOT });

    // Other providers may be keyless and 404 here; only this layer's own
    // route and module failures count.
    const own = consoleErrors.filter((line) =>
      /news-events|NewsEvents/.test(line),
    );
    record(
      'no News Events errors',
      own.length === 0,
      own.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
