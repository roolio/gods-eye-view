import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSIT_MODES } from './source.js';
import {
  stationOutlineColor,
  stationPixelSize,
  trackWidthPx,
} from './style.js';

test('level-0 widths by mode, casing widths by level only', () => {
  assert.deepEqual(
    TRANSIT_MODES.map((mode) => trackWidthPx(mode, 0)),
    [4.5, 4, 3, 2.5, 2.5],
  );
  assert.deepEqual(
    [1, 2, 3].map((level) => trackWidthPx('tram', level)),
    [7.5, 10.5, 13.5],
  );
  assert.deepEqual(
    [1, 2, 3].map((level) => trackWidthPx('rer', level)),
    [7.5, 10.5, 13.5],
  );
});

test('a cased line is wider than every line drawn above it', () => {
  for (let level = 1; level <= 3; level++) {
    for (const below of TRANSIT_MODES) {
      for (const above of TRANSIT_MODES) {
        assert.ok(
          trackWidthPx(below, level) > trackWidthPx(above, level - 1),
          `${below}@${level} vs ${above}@${level - 1}`,
        );
      }
    }
  }
});

test('station dots grow with the lines they serve', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((count) => stationPixelSize(count)),
    [6, 8, 8, 10, 10],
  );
});

test('a single-line stop is ringed in its line colour, an interchange in near-black', () => {
  const m1 = { color: '#FFBE00' };
  const m4 = { color: '#A0006E' };
  assert.equal(stationOutlineColor({ lines: [m1] }), '#FFBE00');
  assert.equal(stationOutlineColor({ lines: [m1, m4] }), '#1A1A1A');
});
