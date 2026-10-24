import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
try {
  fs.mkdirSync('qa-shots', { recursive: true });
  const page = await browser.newPage();
  await page.bringToFront();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = String(input?.url || input);
      if (!url.includes('/api/bitchat/')) return original(input, options);
      const at = Math.floor(Date.now() / 1000);
      const value = url.includes('/messages')
        ? {
            cell: 'u09',
            people: 12,
            messages: [
              {
                text: '<img src=x onerror=alert(1)> synthetic public text',
                at,
              },
            ],
          }
        : {
            status: 'live',
            precision: 3,
            generatedAt: at,
            relays: { listed: 377, open: 300 },
            cells: [{ geohash: 'u09', people: 12, messages: 1, lastAt: at }],
            coarse: [{ geohash: 'u0', people: 20 }],
          };
      return new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });
  await page.goto(process.argv[2] || 'http://127.0.0.1:4173/?welcome=0', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90000,
  });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await page.keyboard.press('Escape');
  const result = await page.evaluate(async () => {
    const { dataManager, viewer } = window.__godsEyeView;
    const before = dataManager.layers.get('bitchat').enabled;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (2.1 * Math.PI) / 180,
        latitude: (48.5 * Math.PI) / 180,
        height: 3000000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const enabled = await dataManager.setEnabled('bitchat', true);
    return {
      before,
      enabled,
      stats: dataManager.layers.get('bitchat').module.getStats(),
    };
  });
  assert.equal(result.before, false);
  assert.equal(result.enabled, true);
  assert.equal(result.stats.count, 1);
  assert.equal(result.stats.status, 'live');
  await page.waitForFunction(
    () => {
      const { viewer } = window.__godsEyeView;
      viewer.scene.requestRender();
      viewer.render();
      for (let i = 0; i < viewer.scene.groundPrimitives.length; i++) {
        const group = viewer.scene.groundPrimitives.get(i);
        if (group.id === 'bitchat') return group.get(0)?.ready;
      }
      return false;
    },
    { timeout: 30000, polling: 250 },
  );
  const point = await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    const p = viewer.scene.cartesianToCanvasCoordinates(
      viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (2.1 * Math.PI) / 180,
        latitude: (48.5 * Math.PI) / 180,
        height: 0,
      }),
    );
    return { x: p.x, y: p.y, picked: viewer.scene.pick(p)?.id ?? null };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector('.bitchat-card', { timeout: 10000 });
  assert.equal(
    await page.$eval(
      '.bitchat-card',
      (card) => card.querySelectorAll('img').length,
    ),
    0,
  );
  assert.equal(
    await page.$eval('.bitchat-card', (card) =>
      card.textContent.includes('synthetic public text'),
    ),
    true,
  );
  await page.screenshot({ path: 'qa-shots/bitchat.png' });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bitchat', false),
  );
  assert.equal(await page.$('.bitchat-card'), null);
  console.log(
    'PASS 7 Bitchat browser assertions. Default off, enable, geometry, health, picking, text safety, disable.',
  );
} finally {
  await browser.close();
}
