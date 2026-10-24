import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSIT_NETWORK_LINES } from './catalog.js';
import {
  COMPILE_PARAMS,
  compileTransitNetwork,
  serializeTransitNetwork,
} from './compile.js';

const lineSubset = (...ids) =>
  TRANSIT_NETWORK_LINES.filter((line) => ids.includes(line.id));

let nextObjectId = 10_000;
function trace(
  idrefligc,
  resCom,
  coordinates,
  { colour = '336699', objectId } = {},
) {
  return {
    type: 'Feature',
    properties: {
      objectid_1: objectId ?? nextObjectId++,
      idrefligc,
      res_com: resCom,
      colourweb_hexa: colour,
    },
    geometry: { type: 'LineString', coordinates },
  };
}

let nextGareId = 50_000;
function gare(group, idrefligc, resCom, name, coordinates) {
  return {
    type: 'Feature',
    properties: {
      id_gares: nextGareId++,
      id_gare_g: group,
      idrefligc,
      res_com: resCom,
      nom_gares: name,
    },
    geometry: { type: 'Point', coordinates },
  };
}

const collection = (features) => ({ type: 'FeatureCollection', features });

function compile(traces, stations, ids) {
  return compileTransitNetwork(
    { traces: collection(traces), stations: collection(stations) },
    { lines: lineSubset(...ids) },
  );
}

function lineFeature(network, id) {
  return network.features.find((feature) => feature.id === id);
}

const east = (metres) => 2.3 + metres / COMPILE_PARAMS.metresPerDegreeLon;

test('drops TER rows that reuse RER ids and every out-of-scope line, by res_com', () => {
  const { network, report } = compile(
    [
      trace(
        'C01727',
        'RER C',
        [
          [2.3, 48.8],
          [2.31, 48.8],
        ],
        { colour: 'ffcc30' },
      ),
      trace(
        'C01728',
        'RER D',
        [
          [2.3, 48.9],
          [2.31, 48.9],
        ],
        { colour: '008b5b' },
      ),
      trace(
        'C01727',
        'TER',
        [
          [1.09, 49.44],
          [1.1, 49.44],
        ],
        { colour: null },
      ),
      trace('C01728', 'TER HAUTS-DE-FRANCE', [
        [2.3, 48.9],
        [2.4, 49.0],
      ]),
      trace('C02833', 'METRO 18', [
        [2.2, 48.7],
        [2.21, 48.7],
      ]),
      trace('C02732', 'TRAM 14', [
        [2.5, 48.9],
        [2.51, 48.9],
      ]),
      trace('C02666', 'CABLE 1', [
        [2.5, 48.7],
        [2.51, 48.7],
      ]),
      trace('C01385', 'FUNICULAIRE MONTMART', [
        [2.343, 48.885],
        [2.343, 48.886],
      ]),
    ],
    [
      gare(1, 'C01727', 'RER C', 'Gare C', [2.3, 48.8]),
      gare(2, 'C01728', 'RER D', 'Gare D', [2.3, 48.9]),
      gare(2, 'C01728', 'TER HAUTS-DE-FRANCE', 'Gare D', [2.3, 48.9]),
    ],
    ['C01727', 'C01728'],
  );
  assert.deepEqual(report.droppedTraceRowsByResCom, {
    TER: 1,
    'TER HAUTS-DE-FRANCE': 1,
    'METRO 18': 1,
    'TRAM 14': 1,
    'CABLE 1': 1,
    'FUNICULAIRE MONTMART': 1,
  });
  assert.deepEqual(report.droppedStationRowsByResCom, {
    'TER HAUTS-DE-FRANCE': 1,
  });
  assert.deepEqual(
    network.features.map((feature) => feature.id),
    ['C01727:0', 'C01728:0', 'gare:1', 'gare:2'],
  );
  assert.deepEqual(lineFeature(network, 'C01728:0').geometry.coordinates, [
    [
      [2.3, 48.9],
      [2.31, 48.9],
    ],
  ]);
  assert.deepEqual(lineFeature(network, 'C01728:0').properties, {
    kind: 'line',
    line: 'C01728',
    code: 'D',
    name: 'RER D',
    mode: 'rer',
    color: '#008B5B',
    rank: 3,
    level: 0,
  });
  assert.deepEqual(lineFeature(network, 'gare:2').properties.lineIds, [
    'C01728',
  ]);
});

test('repairs the truncated TRAIN J row, which inherits the line colour', () => {
  const { network, report } = compile(
    [
      trace(
        'C0173',
        'TRAIN J',
        [
          [2.2, 48.9],
          [2.21, 48.9],
        ],
        { colour: null, objectId: 550 },
      ),
      trace(
        'C01739',
        'TRAIN J',
        [
          [2.21, 48.9],
          [2.22, 48.9],
        ],
        { colour: 'cec73d' },
      ),
    ],
    [gare(7, 'C01739', 'TRAIN J', 'Gare J', [2.21, 48.9])],
    ['C01739'],
  );
  assert.deepEqual(report.repairsApplied, [
    'objectid_1 550: idrefligc C0173 -> C01739',
  ]);
  const j = lineFeature(network, 'C01739:0');
  assert.equal(j.properties.color, '#CEC73D');
  assert.deepEqual(j.geometry.coordinates, [
    [
      [2.2, 48.9],
      [2.21, 48.9],
    ],
    [
      [2.21, 48.9],
      [2.22, 48.9],
    ],
  ]);
});

test('fails when object 550 carries an identity the repair does not expect', () => {
  assert.throws(
    () =>
      compile(
        [
          trace(
            'C01739',
            'TRAIN J',
            [
              [2.2, 48.9],
              [2.21, 48.9],
            ],
            { objectId: 550 },
          ),
        ],
        [gare(7, 'C01739', 'TRAIN J', 'Gare J', [2.21, 48.9])],
        ['C01739'],
      ),
    /objectid_1 550: unexpected identity \{"res_com":"TRAIN J","idrefligc":"C01739"\}/,
  );
});

test('fails on a line with two colours, a missing track, or a missing station', () => {
  const m1 = (colour) =>
    trace(
      'C01371',
      'METRO 1',
      [
        [2.3, 48.86],
        [2.31, 48.86],
      ],
      { colour },
    );
  const m1Station = gare(1, 'C01371', 'METRO 1', 'Gare 1', [2.3, 48.86]);
  assert.throws(
    () => compile([m1('ffbe00'), m1('FFFFFF')], [m1Station], ['C01371']),
    /C01371: METRO 1 has 2 colours \(#FFBE00, #FFFFFF\)/,
  );
  assert.throws(
    () => compile([m1('ffbe00')], [m1Station], ['C01371', 'C01372']),
    /C01372: METRO 2 has no track/,
  );
  assert.throws(
    () => compile([m1('ffbe00')], [], ['C01371']),
    /C01371: METRO 1 has no station/,
  );
});

test('rejects a coordinate outside Île-de-France, such as swapped lon/lat', () => {
  assert.throws(
    () =>
      compile(
        [
          trace('C01371', 'METRO 1', [
            [48.86, 2.3],
            [48.87, 2.3],
          ]),
        ],
        [gare(1, 'C01371', 'METRO 1', 'Gare 1', [2.3, 48.86])],
        ['C01371'],
      ),
    /objectid_1 \d+ \(METRO 1\): coordinate \[48\.86,2\.3\] outside Île-de-France/,
  );
});

test('casing: the worse-ranked line is cased only along the shared run', () => {
  const { network } = compile(
    [
      trace(
        'C01728',
        'RER D',
        [
          [east(0), 48.86],
          [east(1000), 48.86],
        ],
        { colour: '008b5b' },
      ),
      trace(
        'C01743',
        'RER B',
        [
          [east(500), 48.86],
          [east(1000), 48.86],
        ],
        { colour: '5091cb' },
      ),
      trace(
        'C01742',
        'RER A',
        [
          [east(250), 48.855],
          [east(250), 48.865],
        ],
        { colour: 'eb2132' },
      ),
    ],
    [
      gare(1, 'C01728', 'RER D', 'Ouest', [east(0), 48.86]),
      gare(2, 'C01743', 'RER B', 'Est', [east(1000), 48.86]),
      gare(3, 'C01742', 'RER A', 'Nord', [east(250), 48.865]),
    ],
    ['C01742', 'C01743', 'C01728'],
  );
  const lines = network.features.filter(
    (feature) => feature.properties.kind === 'line',
  );
  assert.deepEqual(
    lines.map((feature) => [feature.id, feature.geometry.coordinates]),
    [
      [
        'C01742:0',
        [
          [
            [2.30342, 48.855],
            [2.30342, 48.865],
          ],
        ],
      ],
      [
        'C01743:0',
        [
          [
            [2.30684, 48.86],
            [2.31368, 48.86],
          ],
        ],
      ],
      [
        'C01728:0',
        [
          [
            [2.3, 48.86],
            [2.30656, 48.86],
          ],
        ],
      ],
      [
        'C01728:1',
        [
          [
            [2.30656, 48.86],
            [2.31368, 48.86],
          ],
        ],
      ],
    ],
  );
});

test('keeps disconnected segments apart and simplifies at 2 m', () => {
  const { network } = compile(
    [
      trace('C01383', 'METRO 13', [
        [2.3, 48.86],
        [2.301, 48.86],
        [2.302, 48.86],
      ]),
      trace('C01383', 'METRO 13', [
        [2.30311, 48.86],
        [2.304, 48.86045],
        [2.305, 48.86],
      ]),
      trace('C01383', 'METRO 13', [
        [2.306123456, 48.861],
        [2.307987654, 48.861],
      ]),
    ],
    [gare(1, 'C01383', 'METRO 13', 'Gare 13', [2.3, 48.86])],
    ['C01383'],
  );
  assert.deepEqual(lineFeature(network, 'C01383:0').geometry, {
    type: 'MultiLineString',
    coordinates: [
      [
        [2.3, 48.86],
        [2.302, 48.86],
      ],
      [
        [2.30311, 48.86],
        [2.304, 48.86045],
        [2.305, 48.86],
      ],
      [
        [2.30612, 48.861],
        [2.30799, 48.861],
      ],
    ],
  });
});

test('splits a station group at 700 m and keeps closer members together', () => {
  const { network, report } = compile(
    [
      trace(
        'C01389',
        'TRAM 1',
        [
          [2.28, 48.93],
          [2.31, 48.93],
        ],
        { colour: '0055c8' },
      ),
      trace(
        'C01383',
        'METRO 13',
        [
          [2.28, 48.94],
          [2.29, 48.94],
        ],
        { colour: '82c8e6' },
      ),
    ],
    [
      gare(1031, 'C01389', 'TRAM 1', 'Timbaud', [2.30063, 48.93339]),
      gare(1031, 'C01389', 'TRAM 1', 'Les Courtilles', [2.28372, 48.93021]),
      gare(415, 'C01389', 'TRAM 1', 'Pierrefitte Stains', [2.28, 48.93]),
      gare(415, 'C01383', 'METRO 13', 'Pierrefitte  Stains', [2.28, 48.93482]),
    ],
    ['C01389', 'C01383'],
  );
  assert.deepEqual(report.splitStationGroups, [
    '1031 -> 1031-1 (Les Courtilles), 1031-2 (Timbaud)',
  ]);
  const stations = network.features
    .filter((feature) => feature.properties.kind === 'station')
    .map((feature) => [
      feature.id,
      feature.properties.name,
      feature.properties.lineIds,
    ]);
  assert.deepEqual(stations, [
    ['gare:1031-1', 'Les Courtilles', ['C01389']],
    ['gare:1031-2', 'Timbaud', ['C01389']],
    ['gare:415', 'Pierrefitte Stains', ['C01383', 'C01389']],
  ]);
});

test('fails when one line appears twice in one output station', () => {
  assert.throws(
    () =>
      compile(
        [
          trace('C01389', 'TRAM 1', [
            [2.28, 48.93],
            [2.31, 48.93],
          ]),
        ],
        [
          gare(999, 'C01389', 'TRAM 1', 'A', [2.28, 48.93]),
          gare(999, 'C01389', 'TRAM 1', 'B', [2.281, 48.93]),
        ],
        ['C01389'],
      ),
    /station 999: line C01389 appears twice/,
  );
});

test('an interchange takes a platform position, its normalized name and lines in catalog order', () => {
  const tracks = [
    trace(
      'C01371',
      'METRO 1',
      [
        [2.34, 48.85],
        [2.35, 48.86],
      ],
      { colour: 'ffbe00' },
    ),
    trace(
      'C01374',
      'METRO 4',
      [
        [2.34, 48.86],
        [2.35, 48.85],
      ],
      { colour: 'a0006e' },
    ),
    trace(
      'C01384',
      'METRO 14',
      [
        [2.34, 48.855],
        [2.35, 48.855],
      ],
      { colour: '640082' },
    ),
  ];
  const { network } = compile(
    tracks,
    [
      gare(
        111057,
        'C01384',
        'METRO 14',
        'Châtelet',
        [2.346478183587795, 48.859589655583115],
      ),
      gare(
        111057,
        'C01371',
        'METRO 1',
        'Châtelet',
        [2.345803056189625, 48.85928732517127],
      ),
      gare(
        111057,
        'C01374',
        'METRO 4',
        'Châtelet​',
        [2.346768285736801, 48.8597186619952],
      ),
    ],
    ['C01371', 'C01374', 'C01384'],
  );
  assert.deepEqual(lineFeature(network, 'gare:111057'), {
    type: 'Feature',
    id: 'gare:111057',
    properties: {
      kind: 'station',
      name: 'Châtelet',
      lineIds: ['C01371', 'C01374', 'C01384'],
    },
    geometry: { type: 'Point', coordinates: [2.34648, 48.85959] },
  });
});

test('input order never changes the serialized bundle', () => {
  const traces = [
    trace(
      'C01728',
      'RER D',
      [
        [east(0), 48.86],
        [east(1000), 48.86],
      ],
      { colour: '008b5b' },
    ),
    trace(
      'C01743',
      'RER B',
      [
        [east(500), 48.86],
        [east(1000), 48.86],
      ],
      { colour: '5091cb' },
    ),
    trace(
      'C01743',
      'RER B',
      [
        [east(1000), 48.86],
        [east(1500), 48.87],
      ],
      { colour: '5091cb' },
    ),
  ];
  const stations = [
    gare(2, 'C01743', 'RER B', 'Est', [east(1000), 48.86]),
    gare(2, 'C01728', 'RER D', 'Est', [east(1000), 48.86]),
    gare(1, 'C01728', 'RER D', 'Ouest', [east(0), 48.86]),
  ];
  const ids = ['C01743', 'C01728'];
  const forward = serializeTransitNetwork(
    compile(traces, stations, ids).network,
  );
  const reversed = serializeTransitNetwork(
    compile([...traces].reverse(), [...stations].reverse(), ids).network,
  );
  assert.equal(reversed, forward);
  assert.deepEqual(
    JSON.parse(forward).features.map((feature) => feature.id),
    ['C01743:0', 'C01728:0', 'C01728:1', 'gare:1', 'gare:2'],
  );
  assert.equal(forward.split('\n').length, 8);
  assert.match(forward, /^\{"features":\[\n\{"geometry":/);
  assert.match(forward, /\n\],"type":"FeatureCollection"\}\n$/);
});
