import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateLayerQuotas } from '../../data/labelArbiter.js';
import {
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_REFERENCE_LABEL_WINNER_CAP,
} from '../submarineCables/index.js';
import {
  createStationLabelPublisher,
  createStationOverlayEntry,
  selectStationLabelWinners,
} from './labels.js';

const metro = { mode: 'metro', color: '#FFBE00' };
const rer = { mode: 'rer', color: '#5091CB' };

function record(id, distanceM, { lines = [metro], visible = true } = {}) {
  const station = { id, name: `Gare ${id}`, lon: 2.3, lat: 48.86, lines };
  return {
    station,
    entry: createStationOverlayEntry(station, { x: 1, y: 2, z: 3 }),
    visible,
    distanceM,
  };
}

const ids = (records) => records.map((r) => r.station.id);

test('names exist only below 12 km camera height', () => {
  const records = [record('a', 100)];
  assert.deepEqual(ids(selectStationLabelWinners(records, 11_999)), ['a']);
  assert.deepEqual(ids(selectStationLabelWinners(records, 12_000)), []);
});

test('only visible stations within 25 km are offered', () => {
  const records = [
    record('near', 25_000),
    record('far', 25_001),
    record('hidden', 10, { visible: false }),
  ];
  assert.deepEqual(ids(selectStationLabelWinners(records, 3000)), ['near']);
});

test('nearest first; ties go to more lines, then heavy rail, then id', () => {
  const records = [
    record('z-metro', 500),
    record('b-metro', 500),
    record('rer', 500, { lines: [rer] }),
    record('two-lines', 500, { lines: [metro, metro] }),
    record('closest', 499),
  ];
  assert.deepEqual(ids(selectStationLabelWinners(records, 3000)), [
    'closest',
    'two-lines',
    'rer',
    'b-metro',
    'z-metro',
  ]);
});

test('60 candidates publish the 48 nearest, ranked by priority', () => {
  const calls = [];
  const host = {
    setVisible: (...args) => calls.push(['setVisible', ...args]),
    setEntries: (...args) => calls.push(['setEntries', ...args]),
    clearSource: (...args) => calls.push(['clearSource', ...args]),
  };
  const records = Array.from({ length: 60 }, (_, i) =>
    record(`s${String(59 - i).padStart(2, '0')}`, 1000 + (59 - i)),
  );
  const publisher = createStationLabelPublisher({ host });
  publisher.show();
  publisher.publish(selectStationLabelWinners(records, 3000));

  const [, sourceId, entries, options] = calls[1];
  assert.equal(sourceId, 'transit-network:stations');
  assert.equal(entries.length, 48);
  assert.deepEqual(
    entries.slice(0, 2).map((e) => [e.id, e.priority]),
    [
      ['s00', 1000],
      ['s01', 999],
    ],
  );
  assert.deepEqual(entries.at(-1).id, 's47');
  assert.deepEqual(options, {
    cohortLimit: 48,
    collisionCapacity: 24,
    maxVisible: 24,
    moving: false,
  });
  assert.equal(publisher.count(), 48);
});

test('the publisher skips unchanged cohorts and repaints after hide/show', () => {
  const calls = [];
  const host = {
    setVisible: (id, visible) => calls.push(`visible ${visible}`),
    setEntries: (id, entries) =>
      calls.push(`entries ${entries.map((e) => e.id).join(',')}`),
    clearSource: () => calls.push('clear'),
  };
  const a = record('a', 10);
  const b = record('b', 20);
  const publisher = createStationLabelPublisher({ host });
  publisher.publish([a]);
  publisher.show();
  publisher.show();
  publisher.publish([a, b]);
  publisher.publish([a, b]);
  publisher.publish([b, a]);
  publisher.hide();
  publisher.show();
  publisher.publish([b, a]);
  publisher.publish([]);
  assert.deepEqual(calls, [
    'visible true',
    'entries a,b',
    'entries b,a',
    'clear',
    'visible false',
    'visible true',
    'entries b,a',
    'entries ',
  ]);
});

test('beside cable labels, stations take at most 24 slots of the unchanged 96', () => {
  let published = null;
  const host = {
    setVisible() {},
    setEntries: (sourceId, entries, options) => {
      published = { sourceId, entries, options };
    },
    clearSource() {},
  };
  const publisher = createStationLabelPublisher({ host });
  publisher.show();
  publisher.publish(
    selectStationLabelWinners(
      Array.from({ length: 60 }, (_, i) => record(`s${i}`, i)),
      3000,
    ),
  );
  const capacity = Math.max(
    CABLE_OVERLAY_COLLISION_CAPACITY,
    published.options.collisionCapacity,
  );
  const quotas = allocateLayerQuotas(
    new Map([
      [
        published.sourceId,
        Math.min(published.entries.length, published.options.maxVisible),
      ],
      [CABLE_OVERLAY_SOURCE_ID, CABLE_REFERENCE_LABEL_WINNER_CAP],
    ]),
    capacity,
  );
  assert.deepEqual(Object.fromEntries(quotas), {
    'transit-network:stations': 24,
    [CABLE_OVERLAY_SOURCE_ID]: 72,
  });
});
