import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createBitchatLayer } from './index.js';
Cesium.ContextLimits._maximumAliasedLineWidth = 1;
import { layerFeedState } from '../../data/feedState.js';

function harness(getSnapshot) {
  const resources = [];
  const viewer = {
    camera: { positionCartographic: { height: 3000000 } },
    scene: {
      groundPrimitives: {
        add(value) {
          resources.push(value);
          return value;
        },
        remove(value) {
          resources.splice(resources.indexOf(value), 1);
          value.destroy();
        },
      },
    },
  };
  const layer = createBitchatLayer({
    source: {
      getSnapshot,
      getMessages: async () => ({ people: 0, messages: [] }),
    },
  });
  layer.init(viewer);
  return { layer, viewer, resources };
}
const snapshot = {
  status: 'live',
  relays: { listed: 377, open: 300 },
  cells: [{ geohash: 'u09', people: 10, messages: 5, lastAt: 1000 }],
  coarse: [{ geohash: 'u0', people: 20 }],
};

test('each instance owns batched rectangles, outlines and cleanup', async () => {
  const calls = [];
  const a = harness(async (query) => {
    calls.push(query);
    return snapshot;
  });
  const b = harness(async () => snapshot);
  assert.equal(await a.layer.update(), false);
  a.layer.enable();
  assert.equal(await a.layer.update(), true);
  assert.deepEqual(calls, [{ precision: 3 }]);
  const fill = a.resources[0].get(0);
  assert.equal(fill.geometryInstances.length, 1);
  assert.equal(fill.geometryInstances[0].id, 'bitchat:u09');
  assert.equal(
    fill.geometryInstances[0].geometry instanceof Cesium.RectangleGeometry,
    true,
  );
  assert.equal(a.resources[1].get(0).geometryInstances.length, 1);
  assert.equal(b.resources[0].length, 0);
  assert.equal(layerFeedState(a.layer.getStats()), 'nominal');
  a.layer.disable();
  assert.equal(a.resources[0].length, 0);
  assert.equal(a.resources[0].show, false);
  a.layer.destroy();
  b.layer.destroy();
  assert.equal(a.resources.length, 0);
  assert.equal(fill.isDestroyed(), true);
});

test('disable aborts acquisition and late data cannot repopulate the display', async () => {
  let resolve, signal;
  const h = harness((_query, options) => {
    signal = options.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  h.layer.enable();
  const request = h.layer.update();
  h.layer.disable();
  assert.equal(signal.aborted, true);
  resolve(snapshot);
  assert.equal(await request, false);
  assert.equal(h.resources[0].length, 0);
  h.layer.destroy();
});

test('warming and degraded coverage report through feed health and failure clears geometry', async () => {
  let status = 'warming';
  const h = harness(async () => {
    if (status === 'failure') throw new Error('offline');
    return { ...snapshot, status };
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'loading');
  status = 'degraded';
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  status = 'failure';
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
  assert.equal(h.resources[0].length, 0);
  h.layer.destroy();
});
