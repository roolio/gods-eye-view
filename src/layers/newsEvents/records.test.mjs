import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateNewsEvents,
  gdeltStampToMs,
  normalizeNewsEventsSnapshot,
  parseGdeltEventsExport,
} from './records.js';

// One unmodified line of the 2026-10-25 08:00 UTC export.
const REAL_LINE =
  '1329732395\t20261018\t202610\t2026\t2026.7890\t\t\t\t\t\t\t\t\t\t\tOPP\tPROTESTER\t\t\t\t\t\tOPP\t\t\t1\t190\t190\t19\t4\t-10.0\t2\t1\t2\t-9.9009900990099\t0\t\t\t\t\t\t\t\t4\tRome, Lazio, Italy\tIT\tIT07\t18350\t41.9\t12.4833\t-126693\t4\tRome, Lazio, Italy\tIT\tIT07\t18350\t41.9\t12.4833\t-126693\t20261025080000\thttps://arynews.tv/protests-sweep-italian-cities-amid-heavy-security-presence-some-violence-reported';

/** A 61-column export line with the fields this layer reads. */
function line({
  id = '1',
  actor1 = 'POLICE',
  actor2 = 'PROTESTER',
  root = '14',
  quad = '3',
  mentions = '1',
  geoType = '4',
  place = 'Paris, Ile-de-France, France',
  lat = '48.8667',
  lon = '2.3333',
  featureId = '-1456928',
  added = '20261025080000',
  url = 'https://example.org/a',
} = {}) {
  const cells = Array(61).fill('');
  Object.assign(cells, {
    0: id,
    6: actor1,
    16: actor2,
    25: '1',
    26: `${root}0`,
    28: root,
    29: quad,
    31: mentions,
    51: geoType,
    52: place,
    53: 'FR',
    56: lat,
    57: lon,
    58: featureId,
    59: added,
    60: url,
  });
  return cells.join('\t');
}

test('a real export line maps to the documented columns', () => {
  const [row] = parseGdeltEventsExport(`${REAL_LINE}\r\n`);
  assert.deepEqual(row, {
    id: '1329732395',
    category: 'violence',
    eventCode: '190',
    rootEvent: true,
    actor1: null,
    actor2: 'Protester',
    goldstein: -10,
    mentions: 2,
    sources: 1,
    articles: 2,
    tone: -9.9009900990099,
    place: 'Rome, Lazio, Italy',
    country: 'IT',
    lat: 41.9,
    lon: 12.4833,
    locationId: '-126693',
    timeMs: Date.UTC(2026, 9, 25, 8, 0, 0),
    url: 'https://arynews.tv/protests-sweep-italian-cities-amid-heavy-security-presence-some-violence-reported',
  });
});

test('only city-level conflict and unrest with a usable location and link survive', () => {
  const text = [
    line({ id: '1' }),
    line({ id: '2', quad: '1', root: '04' }), // cooperation
    line({ id: '3', geoType: '1' }), // country centroid
    line({ id: '4', lat: '0', lon: '0' }), // geocoder failure
    line({ id: '5', url: 'javascript:alert(1)' }),
    line({ id: '6', lat: '91' }),
    line({ id: '7' }).split('\t').slice(0, 40).join('\t'), // truncated
    line({ id: '8', geoType: '3', root: '18', quad: '4' }),
  ].join('\n');
  assert.deepEqual(
    parseGdeltEventsExport(text).map(({ id, category }) => [id, category]),
    [
      ['1', 'protest'],
      ['8', 'violence'],
    ],
  );
});

test('an article coded into several events counts once per location', () => {
  const events = parseGdeltEventsExport(
    [
      line({ id: '1', root: '14', mentions: '2', url: 'https://a.example/x' }),
      line({
        id: '2',
        root: '19',
        quad: '4',
        mentions: '9',
        url: 'https://a.example/x',
      }),
      line({ id: '3', root: '14', url: 'https://www.b.example/y' }),
      line({ id: '4', root: '14', url: 'https://c.example/z' }),
      line({
        id: '5',
        featureId: '',
        lat: '51.5',
        lon: '-0.12',
        place: 'London, UK',
        url: 'https://d.example/w',
      }),
    ].join('\n'),
  );
  const [paris, london] = aggregateNewsEvents(events);
  assert.equal(paris.stableId, '-1456928');
  assert.equal(paris.articleCount, 3);
  assert.deepEqual(paris.categories, {
    violence: 1,
    protest: 2,
    coercion: 0,
    tension: 0,
  });
  assert.equal(paris.dominant, 'protest');
  assert.equal(paris.mentions, 11);
  assert.deepEqual(
    paris.events.map(({ category, domain }) => [category, domain]),
    [
      ['violence', 'a.example'],
      ['protest', 'b.example'],
      ['protest', 'c.example'],
    ],
  );
  assert.equal(london.stableId, '51.500,-0.120');
  assert.equal(aggregateNewsEvents(events, { limit: 1 }).length, 1);
});

test('a category tie resolves to the more severe kind', () => {
  const [row] = aggregateNewsEvents(
    parseGdeltEventsExport(
      [
        line({ id: '1', root: '11', url: 'https://a.example/1' }),
        line({ id: '2', root: '18', quad: '4', url: 'https://a.example/2' }),
      ].join('\n'),
    ),
  );
  assert.equal(row.dominant, 'violence');
});

test('actor names read as names, with two-letter codes kept upper-case', () => {
  const [row] = parseGdeltEventsExport(
    line({ actor1: 'US GOVERNMENT', actor2: 'PRIME MINISTER' }),
  );
  assert.equal(row.actor1, 'US Government');
  assert.equal(row.actor2, 'Prime Minister');
});

test('compact dates must name a real instant', () => {
  assert.equal(gdeltStampToMs('20261025081500'), Date.UTC(2026, 9, 25, 8, 15));
  assert.equal(gdeltStampToMs('20261325081500'), null);
  assert.equal(gdeltStampToMs('20260231000000'), null);
  assert.equal(gdeltStampToMs(''), null);
});

test('the browser keeps valid locations and rejects only a missing list', () => {
  assert.equal(normalizeNewsEventsSnapshot({}), null);
  const valid = {
    stableId: 'x',
    lat: 1,
    lon: 2,
    articleCount: 3,
    dominant: 'protest',
    categories: { protest: 3 },
    events: [
      { category: 'protest', url: 'https://a.example/' },
      { category: 'protest', url: 'javascript:void 0' },
    ],
  };
  const rows = normalizeNewsEventsSnapshot({
    locations: [
      valid,
      { ...valid }, // duplicate id
      { ...valid, stableId: 'bad-lat', lat: 120 },
      { ...valid, stableId: 'bad-kind', dominant: 'riot' },
      { ...valid, stableId: 'empty', articleCount: 0 },
    ],
  });
  assert.deepEqual(
    rows.map(({ stableId }) => stableId),
    ['x'],
  );
  assert.deepEqual(rows[0].categories, {
    violence: 0,
    protest: 3,
    coercion: 0,
    tension: 0,
  });
  assert.equal(rows[0].events.length, 1);
});
