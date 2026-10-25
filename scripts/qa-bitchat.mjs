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
    window.__bitchatDrawnText = new Set();
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      window.__bitchatDrawnText.add(String(text));
      return fillText.call(this, text, ...args);
    };
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = String(input?.url || input);
      if (!url.includes('/api/bitchat/')) return original(input, options);
      const at = Math.floor(Date.now() / 1000);
      const value = url.includes('/messages')
        ? {
            cell: 'u09t',
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
            precision: 4,
            generatedAt: at,
            relays: { listed: 377, open: 300 },
            cells: [{ geohash: 'u09t', people: 12, messages: 1, lastAt: at }],
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
        longitude: (2.28515625 * Math.PI) / 180,
        latitude: (48.779296875 * Math.PI) / 180,
        height: 800000,
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
        longitude: (2.28515625 * Math.PI) / 180,
        latitude: (48.779296875 * Math.PI) / 180,
        height: 0,
      }),
    );
    return { x: p.x, y: p.y, picked: viewer.scene.pick(p)?.id ?? null };
  });
  assert.equal(point.picked, null);
  await page.evaluate(async () => {
    const Cesium = await import('/node_modules/.vite/deps/cesium.js');
    const picking = await import('/src/data/pickRegistry.js');
    picking.registerPickOwner(
      'bitchat-qa-contact',
      (id) => id === 'bitchat-qa-contact',
    );
    window.__bitchatQaContact = window.__godsEyeView.viewer.entities.add({
      id: 'bitchat-qa-contact',
      position: Cesium.Cartesian3.fromDegrees(2.28515625, 48.779296875, 1000),
      point: {
        pixelSize: 30,
        color: Cesium.Color.CYAN,
        disableDepthTestDistance: Infinity,
      },
    });
  });
  await page.waitForFunction(
    ({ x, y }) => {
      const { viewer } = window.__godsEyeView;
      viewer.render();
      return viewer.scene.pick({ x, y })?.id?.id === 'bitchat-qa-contact';
    },
    { timeout: 10000 },
    point,
  );
  await page.mouse.click(point.x, point.y);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    await page.evaluate(
      () =>
        window.__gevWorldOverlay.getDiagnostics().entriesBySource[
          'bitchat-card'
        ] || 0,
    ),
    0,
  );
  await page.evaluate(async () => {
    window.__godsEyeView.viewer.entities.remove(window.__bitchatQaContact);
    const picking = await import('/src/data/pickRegistry.js');
    picking.unregisterPickOwner('bitchat-qa-contact');
    window.__godsEyeView.viewer.render();
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(
    () =>
      window.__gevWorldOverlay.getDiagnostics().paintedBySource[
        'bitchat-card'
      ] === 1,
    { timeout: 10000 },
  );
  assert.equal(
    await page.evaluate(() => window.__bitchatDrawnText.has('BITCHAT · u09t')),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      [...window.__bitchatDrawnText].some((text) =>
        text.startsWith(
          '<img src=x onerror=alert(1)> synthetic public text · ',
        ),
      ),
    ),
    true,
  );
  assert.equal(await page.$('img[onerror]'), null);
  await page.screenshot({ path: 'qa-shots/bitchat-card.png' });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('bitchat', false),
  );
  await page.waitForFunction(
    () =>
      !window.__gevWorldOverlay.getDiagnostics().paintedBySource[
        'bitchat-card'
      ],
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__gevWorldOverlay.getDiagnostics().entriesBySource[
          'bitchat-card'
        ] || 0,
    ),
    0,
  );
  console.log(
    'PASS 10 Bitchat browser assertions. Default off, enable, geometry, health, empty-ground selection, contact ownership, HUD card, literal text safety, disable, cleanup.',
  );
} finally {
  await browser.close();
}
