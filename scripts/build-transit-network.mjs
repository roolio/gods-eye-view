#!/usr/bin/env node
/**
 * Compile the bundled Île-de-France rail network from two IDFM exports.
 *
 *   node scripts/build-transit-network.mjs \
 *     --traces traces.geojson --stations gares.geojson \
 *     --captured-at 2026-10-24 --out src/data/local_data/idfm_transit_network [--check]
 *
 * --check writes nothing and exits 1 when the committed files differ from
 * what these inputs compile to.
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  COMPILE_PARAMS,
  canonicalJson,
  compileTransitNetwork,
  serializeTransitNetwork,
} from '../src/layers/transitNetwork/compile.js';
import { TRANSIT_NETWORK_LINES } from '../src/layers/transitNetwork/catalog.js';

const DATASETS = {
  traces: {
    dataset: 'traces-du-reseau-ferre-idf',
    url: 'https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/traces-du-reseau-ferre-idf/exports/geojson',
  },
  stations: {
    dataset: 'emplacement-des-gares-idf',
    url: 'https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/emplacement-des-gares-idf/exports/geojson',
  },
};
const NETWORK_FILE = 'network.geojson';
const SOURCE_FILE = 'source.json';

function parseArgs(argv) {
  const args = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--check') args.check = true;
    else if (
      ['--traces', '--stations', '--captured-at', '--out'].includes(flag)
    ) {
      args[flag.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${flag}`);
  }
  for (const name of ['traces', 'stations', 'captured-at', 'out']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args['captured-at'])) {
    throw new Error('--captured-at must be YYYY-MM-DD');
  }
  return args;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawTraces = await readFile(args.traces);
  const rawStations = await readFile(args.stations);
  const traces = JSON.parse(rawTraces.toString('utf8'));
  const stations = JSON.parse(rawStations.toString('utf8'));
  if (TRANSIT_NETWORK_LINES.length !== 46) {
    throw new Error(
      `catalog has ${TRANSIT_NETWORK_LINES.length} lines, expected 46`,
    );
  }
  const { network, report } = compileTransitNetwork({ traces, stations });
  const networkText = serializeTransitNetwork(network);
  const networkBytes = Buffer.from(networkText, 'utf8');

  const source = {
    id: 'idfm-transit-network',
    name: 'Île-de-France rail network',
    publisher: 'Île-de-France Mobilités',
    license: {
      name: 'Licence Ouverte 2.0',
      url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
    },
    captured_at: args['captured-at'],
    inputs: [
      {
        ...DATASETS.traces,
        features: traces.features.length,
        sha256: sha256(rawTraces),
      },
      {
        ...DATASETS.stations,
        features: stations.features.length,
        sha256: sha256(rawStations),
      },
    ],
    files: [
      {
        path: NETWORK_FILE,
        bytes: networkBytes.length,
        sha256: sha256(networkBytes),
      },
    ],
    counts: report.counts,
    retained: report.retained,
    report: {
      droppedTraceRowsByResCom: report.droppedTraceRowsByResCom,
      droppedStationRowsByResCom: report.droppedStationRowsByResCom,
      repairsApplied: report.repairsApplied,
      repairsUnused: report.repairsUnused,
      splitStationGroups: report.splitStationGroups,
      degenerateComponents: report.degenerateComponents,
    },
    compiler: COMPILE_PARAMS,
  };
  const outputs = [
    [NETWORK_FILE, networkBytes],
    [SOURCE_FILE, Buffer.from(`${canonicalJson(source, 2)}\n`, 'utf8')],
  ];

  console.log(
    `lines ${report.counts.lines}, strands ${report.counts.strands}, paths ${report.counts.paths}, ` +
      `vertices ${report.counts.vertices} (raw ${report.retained.rawVertices}), ` +
      `stations ${report.counts.stations}, max casing level ${report.counts.maxLevel}`,
  );
  console.log(
    `${NETWORK_FILE}: ${networkBytes.length} bytes, ${gzipSync(networkBytes, { level: 9 }).length} bytes gzip`,
  );
  console.log(
    `dropped trace rows: ${JSON.stringify(report.droppedTraceRowsByResCom)}`,
  );
  console.log(
    `dropped station rows: ${JSON.stringify(report.droppedStationRowsByResCom)}`,
  );
  console.log(`repairs applied: ${JSON.stringify(report.repairsApplied)}`);
  if (report.repairsUnused.length)
    console.log(`repairs unused: ${JSON.stringify(report.repairsUnused)}`);
  console.log(
    `split station groups: ${JSON.stringify(report.splitStationGroups)}`,
  );
  console.log(`degenerate components dropped: ${report.degenerateComponents}`);

  if (args.check) {
    const drift = [];
    for (const [name, bytes] of outputs) {
      const current = await readFile(path.join(args.out, name)).catch(
        () => null,
      );
      if (!current || !current.equals(bytes)) drift.push(name);
    }
    if (drift.length) {
      console.error(
        `drift: ${drift.join(', ')} differ from the compiled output`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('check: committed bundle matches the compiled output');
    return;
  }
  for (const [name, bytes] of outputs) {
    const target = path.join(args.out, name);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
  console.log(
    `wrote ${outputs.map(([name]) => name).join(', ')} to ${args.out}`,
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
