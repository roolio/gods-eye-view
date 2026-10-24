import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createFloodVigilanceLayer } from './index.js';
import { normalizeVigicruesSnapshot } from './records.js';
import { createFloodVigilanceSource } from './source.js';
import {
  clickSeam,
  fakeViewer,
  picking,
  recordingHost,
} from './testFixtures.mjs';

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );

const bulletin = () => ({
  fetchedAt: 1000,
  ...normalizeVigicruesSnapshot(fixture('vigicrues-infovigicru.json')),
});

function setup({ respond = () => Response.json(bulletin()) } = {}) {
  const requests = [];
  const source = createFloodVigilanceSource({
    fetchImpl: async (url) => {
      requests.push(url);
      return respond(url);
    },
  });
  const viewer = fakeViewer();
  const host = recordingHost();
  const seam = clickSeam();
  const stackEvents = new EventTarget();
  const layer = createFloodVigilanceLayer({
    source,
    overlayHost: host,
    screenSpaceEventHandlerFactory: seam.factory,
    picking,
    pointer: { isPointerFree: () => true },
    mapStackEventTarget: stackEvents,
    now: () => 2000,
  });
  layer.init(viewer);
  return { layer, viewer, host, seam, stackEvents, requests };
}

function lineSummary(viewer) {
  const collection = viewer.scene.groundPrimitives.get(0);
  return Array.from({ length: collection.length }, (_, i) => {
    const primitive = collection.get(i);
    const [first] = primitive.geometryInstances;
    const color = Cesium.Color.fromBytes(...first.attributes.color.value);
    return [
      primitive.geometryInstances.map((instance) => instance.id),
      first.geometry.width,
      color.toCssHexString(),
    ];
  });
}

test('enable draws one ground primitive per level, green thin and translucent under yellow', async () => {
  const { layer, viewer, requests } = setup();
  layer.enable(viewer);
  assert.equal(await layer.update(), true);
  assert.deepEqual(requests, ['/api/flood-vigilance/sections']);
  assert.deepEqual(lineSummary(viewer), [
    [['flood-vigilance:section:CO1'], 1.5, '#28d76173'],
    [
      [
        'flood-vigilance:section:AP12',
        'flood-vigilance:section:AP12',
        'flood-vigilance:section:AP6',
        'flood-vigilance:section:AP6',
      ],
      4,
      '#ffff00',
    ],
  ]);
  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  assert.deepEqual(stats.levels, { 1: 1, 2: 2, 3: 0, 4: 0 });
  assert.equal(stats.observedAt, Date.parse('2026-10-24T07:55:59Z'));
  assert.equal(stats.error, null);
  const legend = layer.getRowControls().legend;
  assert.deepEqual(
    legend.map(({ color, count }) => [color, count]),
    [
      ['#28D761', 1],
      ['#FFFF00', 2],
      ['#FFAA00', 0],
      ['#FF0000', 0],
    ],
  );
  assert.match(legend[0].blurb, /Oct 24, 07:55 UTC/);
  assert.equal(layer.getRowControls().info, '2 river sections above green');
});

test('a click on a section opens its card, empty space closes it, another layer leaves it', async () => {
  const { layer, viewer, host, seam } = setup();
  layer.enable(viewer);
  await layer.update();
  viewer.picked = { id: 'flood-vigilance:section:AP6' };
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
  const [card] = host.entries.get('flood-vigilance-card');
  assert.equal(card.title, 'FLOOD VIGILANCE · Liane');
  assert.deepEqual(card.details, [
    'Yellow: localised flooding or a rapid rise',
    'Vigicrues bulletin Oct 24, 07:55 UTC',
    'Section AP6',
  ]);
  assert.equal(card.accent, '#FFFF00');
  assert.ok(card.position instanceof Cesium.Cartesian3);
  viewer.picked = { id: 'other:aircraft' };
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
  assert.equal(host.entries.get('flood-vigilance-card').length, 1);
  viewer.picked = null;
  seam.click({ position: new Cesium.Cartesian2(10, 10) });
  assert.deepEqual(host.entries.get('flood-vigilance-card'), []);
  assert.equal(layer.getStats().selectedId, null);
});

test('a failed refresh keeps the layer on with its last bulletin and reports the error', async () => {
  let status = 200;
  const { layer, viewer } = setup({
    respond: () =>
      status === 200
        ? Response.json(bulletin())
        : new Response('{}', { status }),
  });
  layer.enable(viewer);
  await layer.update();
  status = 502;
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'Vigicrues HTTP 502');
  assert.equal(layer.getStats().count, 3);
  assert.equal(viewer.scene.groundPrimitives.length, 1);
  status = 429;
  await layer.update();
  assert.equal(layer.getStats().error, 'Vigicrues rate limited');
});

test('disable frees the primitives and the card, re-enable redraws without a new request', async () => {
  const { layer, viewer, host, seam, requests, stackEvents } = setup();
  layer.enable(viewer);
  await layer.update();
  viewer.picked = { id: 'flood-vigilance:section:CO1' };
  seam.click({ position: new Cesium.Cartesian2(1, 1) });
  stackEvents.dispatchEvent(
    Object.assign(new Event('gev:map-stack-changed'), {
      detail: { activeId: 'photoreal' },
    }),
  );
  const collection = viewer.scene.groundPrimitives.get(0);
  assert.equal(
    collection.get(0).classificationType,
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  layer.disable();
  assert.equal(viewer.scene.groundPrimitives.length, 0);
  assert.equal(seam.click, null);
  assert.equal(host.entries.has('flood-vigilance-card'), false);
  layer.enable(viewer);
  assert.equal(viewer.scene.groundPrimitives.length, 1);
  assert.equal(
    viewer.scene.groundPrimitives.get(0).get(0).classificationType,
    Cesium.ClassificationType.CESIUM_3D_TILE,
  );
  assert.equal(requests.length, 1);
  layer.destroy();
  assert.equal(viewer.scene.groundPrimitives.length, 0);
});

test('the source drops malformed sections and rejects a payload without them', async () => {
  const source = createFloodVigilanceSource({
    fetchImpl: async () =>
      Response.json({
        publishedAt: 5,
        sections: [
          { id: 'A', name: 'Ok', level: 2, paths: [[2, 48, 2.1, 48.1]] },
          { id: 'B', name: 'Odd', level: 2, paths: [[2, 48, 2.1]] },
          { id: 'C', name: 'Level', level: 9, paths: [[2, 48, 2.1, 48.1]] },
        ],
      }),
  });
  const result = await source.getSections();
  assert.deepEqual(
    result.sections.map(({ id }) => id),
    ['A'],
  );
  assert.equal(result.publishedAt, 5);
  assert.equal(result.stale, false);
  const broken = createFloodVigilanceSource({
    fetchImpl: async () => Response.json({ rows: [] }),
  });
  await assert.rejects(broken.getSections(), /Malformed Vigicrues response/);
});
