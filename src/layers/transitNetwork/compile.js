import { TRANSIT_NETWORK_LINES, TRACE_REPAIRS } from './catalog.js';

export const COMPILE_PARAMS = Object.freeze({
  metresPerDegreeLon: 73120,
  metresPerDegreeLat: 111200,
  idfBounds: Object.freeze({ west: 1.3, south: 47.9, east: 3.5, north: 49.4 }),
  sharedTrackDistanceM: 12,
  sharedTrackSampleM: 20,
  sharedTrackMinAbsDot: 0.98,
  minRunLengthM: 60,
  maxCasingLevel: 3,
  simplifyToleranceM: 2,
  decimals: 5,
  stationSplitDistanceM: 700,
});

const P = COMPILE_PARAMS;
const GRID_CELL_M = 25;

/**
 * @typedef {object} CompileReport
 * @property {Record<string, number>} droppedTraceRowsByResCom
 * @property {Record<string, number>} droppedStationRowsByResCom
 * @property {string[]} repairsApplied
 * @property {string[]} repairsUnused
 * @property {string[]} splitStationGroups
 * @property {number} degenerateComponents Runs that rounded to fewer than two distinct points.
 * @property {{traceRows:number, stationRows:number, rawVertices:number}} retained
 * @property {{lines:number, strands:number, paths:number, vertices:number,
 *   stations:number, maxLevel:number}} counts
 */

/**
 * @param {{traces: unknown, stations: unknown}} raw Parsed IDFM exports.
 * @param {{lines?: ReadonlyArray<import('./catalog.js').CatalogLine>,
 *   repairs?: ReadonlyArray<object>}} [options] Test seams; the CLI passes the defaults.
 * @returns {{network: {type: 'FeatureCollection', features: object[]}, report: CompileReport}}
 */
export function compileTransitNetwork(
  { traces, stations },
  { lines = TRANSIT_NETWORK_LINES, repairs = TRACE_REPAIRS } = {},
) {
  assertFeatureCollection(traces, 'traces');
  assertFeatureCollection(stations, 'stations');
  const lineByPair = new Map(
    lines.map((line) => [pairKey(line.id, line.resCom), line]),
  );
  if (lineByPair.size !== lines.length)
    throw new Error('catalog: duplicate (id, resCom) pair');

  const report = {
    droppedTraceRowsByResCom: {},
    droppedStationRowsByResCom: {},
    repairsApplied: [],
    repairsUnused: [],
    splitStationGroups: [],
    degenerateComponents: 0,
    retained: { traceRows: 0, stationRows: 0, rawVertices: 0 },
    counts: null,
  };

  const traceRows = applyRepairs(
    traces.features.map(readTraceRow),
    repairs,
    report,
  ).sort(compareTraceRows);
  /** @type {Map<string, {line: object, colours: Set<string>, paths: number[][][]}>} */
  const byLine = new Map(
    lines.map((line) => [line.id, { line, colours: new Set(), paths: [] }]),
  );
  for (const row of traceRows) {
    const line = lineByPair.get(pairKey(row.idrefligc, row.resCom));
    if (!line) {
      increment(report.droppedTraceRowsByResCom, row.resCom);
      continue;
    }
    const entry = byLine.get(line.id);
    const colour = normalizeColour(row.colour, row.label);
    if (colour) entry.colours.add(colour);
    entry.paths.push(readLineCoordinates(row.geometry, row.label));
    report.retained.traceRows++;
    report.retained.rawVertices += row.geometry.coordinates.length;
  }

  const colourById = new Map();
  for (const { line, colours, paths } of byLine.values()) {
    if (paths.length === 0)
      throw new Error(`${line.id}: ${line.resCom} has no track`);
    if (colours.size !== 1) {
      throw new Error(
        `${line.id}: ${line.resCom} has ${colours.size} colours (${[...colours].join(', ')})`,
      );
    }
    colourById.set(line.id, [...colours][0]);
  }

  const runs = splitIntoCasingRuns([...byLine.values()]);
  const strands = new Map();
  let maxLevel = 0;
  for (const run of runs) {
    if (run.level > P.maxCasingLevel) {
      throw new Error(
        `${run.line.id}: ${run.line.resCom} needs casing level ${run.level} (max ${P.maxCasingLevel})`,
      );
    }
    const coords = roundedDistinctLonLatPathOrNull(
      simplifyPath(run.points, P.simplifyToleranceM),
    );
    if (!coords) {
      report.degenerateComponents++;
      continue;
    }
    const key = `${run.line.id}:${run.level}`;
    if (!strands.has(key))
      strands.set(key, { line: run.line, level: run.level, paths: [] });
    strands.get(key).paths.push(coords);
    maxLevel = Math.max(maxLevel, run.level);
  }

  const lineFeatures = [...strands.values()]
    .sort((a, b) => a.level - b.level || a.line.rank - b.line.rank)
    .map(({ line, level, paths }) => ({
      type: 'Feature',
      id: `${line.id}:${level}`,
      properties: {
        kind: 'line',
        line: line.id,
        code: line.code,
        name: line.name,
        mode: line.mode,
        color: colourById.get(line.id),
        rank: line.rank,
        level,
      },
      geometry: {
        type: 'MultiLineString',
        coordinates: paths.sort(compareCoordinates),
      },
    }));

  const stationFeatures = compileStations(stations, lineByPair, report);

  for (const line of lines) {
    if (!lineFeatures.some((feature) => feature.properties.line === line.id)) {
      throw new Error(
        `${line.id}: ${line.resCom} has no track after simplification`,
      );
    }
    if (
      !stationFeatures.some((feature) =>
        feature.properties.lineIds.includes(line.id),
      )
    ) {
      throw new Error(`${line.id}: ${line.resCom} has no station`);
    }
  }

  let paths = 0;
  let vertices = 0;
  for (const feature of lineFeatures) {
    paths += feature.geometry.coordinates.length;
    for (const path of feature.geometry.coordinates) vertices += path.length;
  }
  report.counts = {
    lines: lines.length,
    strands: lineFeatures.length,
    paths,
    vertices,
    stations: stationFeatures.length,
    maxLevel,
  };
  return {
    network: {
      type: 'FeatureCollection',
      features: [...lineFeatures, ...stationFeatures],
    },
    report,
  };
}

/**
 * Canonical bundle text: sorted keys, one feature per line, final LF.
 * @param {{features: object[]}} network
 * @returns {string}
 */
export function serializeTransitNetwork(network) {
  const features = network.features.map((feature) => canonicalJson(feature));
  return `{"features":[\n${features.join(',\n')}\n],"type":"FeatureCollection"}\n`;
}

/**
 * JSON with object keys sorted at every depth.
 * @param {unknown} value
 * @param {number} [space]
 * @returns {string}
 */
export function canonicalJson(value, space) {
  return JSON.stringify(sortKeys(value), null, space);
}

/**
 * 'ffbe00' | 'FFBE00' | '#ffbe00' -> '#FFBE00'; null or empty -> null.
 * @param {unknown} value
 * @param {string} [label] Row description for the error.
 * @returns {string|null}
 */
export function normalizeColour(value, label = 'colour') {
  if (value === null || value === undefined || value === '') return null;
  const hex = String(value).trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex))
    throw new Error(`${label}: invalid colour ${JSON.stringify(value)}`);
  return `#${hex.toUpperCase()}`;
}

/**
 * NFC, zero-width characters stripped, whitespace collapsed.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeStationName(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertFeatureCollection(value, label) {
  if (value?.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new TypeError(`${label}: expected a GeoJSON FeatureCollection`);
  }
}

function pairKey(id, resCom) {
  return `${id}\u0000${resCom}`;
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCoordinates(a, b) {
  return compareStrings(JSON.stringify(a), JSON.stringify(b));
}

function readTraceRow(feature) {
  const p = feature?.properties || {};
  return {
    objectId: p.objectid_1,
    idrefligc: String(p.idrefligc ?? ''),
    resCom: String(p.res_com ?? ''),
    colour: p.colourweb_hexa,
    geometry: feature?.geometry,
    // i18n-ignore: build-time diagnostic
    label: `objectid_1 ${p.objectid_1} (${p.res_com})`,
    sortKey: JSON.stringify(feature?.geometry?.coordinates ?? null),
  };
}

function compareTraceRows(a, b) {
  return (
    (Number(a.objectId) || 0) - (Number(b.objectId) || 0) ||
    compareStrings(a.idrefligc, b.idrefligc) ||
    compareStrings(a.resCom, b.resCom) ||
    compareStrings(a.sortKey, b.sortKey)
  );
}

function assertRepairMatchesRowIdentity(row, repair) {
  const found = { res_com: row.resCom, idrefligc: row.idrefligc };
  for (const [key, expected] of Object.entries(repair.match)) {
    if (found[key] !== expected) {
      throw new Error(
        `objectid_1 ${repair.objectId}: unexpected identity ${JSON.stringify(found)}, repair expects ${JSON.stringify(repair.match)}`,
      );
    }
  }
}

function applyRepairs(rows, repairs, report) {
  for (const repair of repairs) {
    const targets = rows.filter((row) => row.objectId === repair.objectId);
    if (targets.length === 0) {
      report.repairsUnused.push(`objectid_1 ${repair.objectId}`);
      continue;
    }
    for (const row of targets) {
      assertRepairMatchesRowIdentity(row, repair);
      report.repairsApplied.push(
        `objectid_1 ${repair.objectId}: idrefligc ${row.idrefligc} -> ${repair.set.idrefligc}`,
      );
      row.idrefligc = repair.set.idrefligc;
    }
  }
  return rows;
}

function assertPosition(position, label) {
  const [lon, lat] = Array.isArray(position) ? position : [];
  const { west, south, east, north } = P.idfBounds;
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < west ||
    lon > east ||
    lat < south ||
    lat > north
  ) {
    throw new Error(
      `${label}: coordinate ${JSON.stringify(position)} outside Île-de-France`,
    );
  }
  return [lon, lat];
}

function readLineCoordinates(geometry, label) {
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
    throw new Error(`${label}: expected a LineString`);
  }
  if (geometry.coordinates.length < 2)
    throw new Error(`${label}: fewer than two coordinates`);
  return geometry.coordinates.map((position) =>
    assertPosition(position, label),
  );
}

function toIdfMetricPlane([lon, lat]) {
  return [lon * P.metresPerDegreeLon, lat * P.metresPerDegreeLat];
}

function fromIdfMetricPlane([x, y]) {
  return [x / P.metresPerDegreeLon, y / P.metresPerDegreeLat];
}

function splitIntoCasingRuns(entries) {
  const metricPaths = entries.map(({ line, paths }) => ({
    line,
    paths: paths.map((path) => path.map(toIdfMetricPlane)),
  }));
  const grid = sharedTrackEdgeGrid(metricPaths);
  const runs = [];
  for (const { line, paths } of metricPaths) {
    for (const path of paths) {
      for (const run of mergeShortRuns(
        casingRunsFromSharedSamples(line, path, grid),
      )) {
        runs.push({ line, level: run.level, points: run.points });
      }
    }
  }
  return runs;
}

function sharedTrackEdgeGrid(metricPaths) {
  const grid = new Map();
  for (const { line, paths } of metricPaths) {
    for (const path of paths) {
      for (let i = 0; i + 1 < path.length; i++) {
        const edge = createEdge(line, path[i], path[i + 1]);
        if (!edge) continue;
        const [x0, x1] = [
          Math.min(edge.ax, edge.bx),
          Math.max(edge.ax, edge.bx),
        ];
        const [y0, y1] = [
          Math.min(edge.ay, edge.by),
          Math.max(edge.ay, edge.by),
        ];
        for (let cx = cell(x0); cx <= cell(x1); cx++) {
          for (let cy = cell(y0); cy <= cell(y1); cy++) {
            const key = cx * 1e7 + cy;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(edge);
          }
        }
      }
    }
  }

  return grid;
}

function cell(value) {
  return Math.floor(value / GRID_CELL_M);
}

function createEdge(line, [ax, ay], [bx, by]) {
  const length = Math.hypot(bx - ax, by - ay);
  if (length === 0) return null;
  return {
    line,
    ax,
    ay,
    bx,
    by,
    length,
    ux: (bx - ax) / length,
    uy: (by - ay) / length,
  };
}

function sharesTrackAtSample(edge, x, y, ux, uy) {
  if (Math.abs(edge.ux * ux + edge.uy * uy) < P.sharedTrackMinAbsDot)
    return false;
  const t = Math.max(
    0,
    Math.min(edge.length, (x - edge.ax) * edge.ux + (y - edge.ay) * edge.uy),
  );
  const dx = x - (edge.ax + edge.ux * t);
  const dy = y - (edge.ay + edge.uy * t);
  return dx * dx + dy * dy <= P.sharedTrackDistanceM * P.sharedTrackDistanceM;
}

function levelFromBetterRankedLines(line, x, y, ux, uy, grid) {
  const reach = P.sharedTrackDistanceM;
  const better = new Set();
  for (let cx = cell(x - reach); cx <= cell(x + reach); cx++) {
    for (let cy = cell(y - reach); cy <= cell(y + reach); cy++) {
      for (const edge of grid.get(cx * 1e7 + cy) || []) {
        if (
          edge.line === line ||
          edge.line.rank >= line.rank ||
          better.has(edge.line)
        )
          continue;
        if (sharesTrackAtSample(edge, x, y, ux, uy)) better.add(edge.line);
      }
    }
  }
  return better.size;
}

function casingRunsFromSharedSamples(line, path, grid) {
  const runs = [];
  let current = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const length = Math.hypot(bx - ax, by - ay);
    if (length === 0) continue;
    const ux = (bx - ax) / length;
    const uy = (by - ay) / length;
    const steps = Math.max(1, Math.ceil(length / P.sharedTrackSampleM));
    for (let k = 0; k < steps; k++) {
      const mid = (k + 0.5) / steps;
      const level = levelFromBetterRankedLines(
        line,
        ax + (bx - ax) * mid,
        ay + (by - ay) * mid,
        ux,
        uy,
        grid,
      );
      if (!current) {
        current = { level, points: [[ax, ay]], length: 0 };
      } else if (level !== current.level) {
        const cut = [
          ax + ((bx - ax) * k) / steps,
          ay + ((by - ay) * k) / steps,
        ];
        pushDistinct(current.points, cut);
        runs.push(current);
        current = { level, points: [cut], length: 0 };
      }
      current.length += length / steps;
    }
    pushDistinct(current.points, [bx, by]);
  }
  runs.push(current || { level: 0, points: [path[0]], length: 0 });
  return runs;
}

function pushDistinct(points, point) {
  const last = points[points.length - 1];
  if (!last || last[0] !== point[0] || last[1] !== point[1]) points.push(point);
}

function mergeShortRuns(input) {
  const runs = coalesce(input);
  while (runs.length > 1) {
    let shortest = -1;
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].length >= P.minRunLengthM) continue;
      if (shortest < 0 || runs[i].length < runs[shortest].length) shortest = i;
    }
    if (shortest < 0) break;
    const previous = runs[shortest - 1];
    const next = runs[shortest + 1];
    const run = runs[shortest];
    if (previous && (!next || previous.length >= next.length)) {
      previous.points.push(...run.points.slice(1));
      previous.length += run.length;
    } else {
      next.points = [...run.points, ...next.points.slice(1)];
      next.length += run.length;
    }
    runs.splice(shortest, 1);
    const merged = coalesce(runs);
    runs.length = 0;
    runs.push(...merged);
  }
  return runs;
}

function coalesce(runs) {
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.level === run.level) {
      last.points.push(...run.points.slice(1));
      last.length += run.length;
    } else {
      out.push(run);
    }
  }
  return out;
}

function simplifyPath(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(points[i], points[first], points[last]);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([first, worst], [worst, last]);
  }
  return points.filter((_, i) => keep[i]);
}

function segmentDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function round(value) {
  const factor = 10 ** P.decimals;
  return Math.round(value * factor) / factor;
}

function roundedDistinctLonLatPathOrNull(points) {
  const coords = [];
  for (const point of points) {
    pushDistinct(coords, fromIdfMetricPlane(point).map(round));
  }
  return coords.length >= 2 ? coords : null;
}

function compileStations(stations, lineByPair, report) {
  const rows = [];
  for (const feature of stations.features) {
    const p = feature?.properties || {};
    const line = lineByPair.get(
      pairKey(String(p.idrefligc ?? ''), String(p.res_com ?? '')),
    );
    if (!line) {
      increment(report.droppedStationRowsByResCom, String(p.res_com ?? ''));
      continue;
    }
    const label = `station row id_gares ${p.id_gares} (${p.res_com})`;
    const group = String(p.id_gare_g ?? '');
    if (!/^\d+$/.test(group)) throw new Error(`${label}: missing id_gare_g`);
    if (feature.geometry?.type !== 'Point')
      throw new Error(`${label}: expected a Point`);
    rows.push({
      group,
      idGares: Number(p.id_gares) || 0,
      line,
      name: normalizeStationName(p.nom_gares),
      position: assertPosition(feature.geometry.coordinates, label),
    });
    report.retained.stationRows++;
  }
  rows.sort(
    (a, b) =>
      Number(a.group) - Number(b.group) ||
      a.idGares - b.idGares ||
      a.line.rank - b.line.rank,
  );

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }

  const features = [];
  for (const [group, members] of groups) {
    const clusters = singleLinkage(members, P.stationSplitDistanceM)
      .map((cluster) => ({ members: cluster, medoid: medoid(cluster) }))
      .sort(
        (a, b) =>
          a.medoid.position[0] - b.medoid.position[0] ||
          a.medoid.position[1] - b.medoid.position[1],
      );
    const split = clusters.length > 1;
    const named = clusters.map(
      ({ members: cluster, medoid: center }, index) => {
        const id = split ? `${group}-${index + 1}` : group;
        return {
          id,
          name: mostFrequentNameWithBestRankedLineTieBreak(cluster),
          cluster,
          center,
        };
      },
    );
    if (split) {
      report.splitStationGroups.push(
        `${group} -> ${named.map(({ id, name }) => `${id} (${name})`).join(', ')}`,
      );
    }
    for (const { id, name, cluster, center } of named) {
      const seen = new Set();
      for (const { line } of cluster) {
        if (seen.has(line.id))
          throw new Error(`station ${id}: line ${line.id} appears twice`);
        seen.add(line.id);
      }
      features.push({
        type: 'Feature',
        id: `gare:${id}`,
        properties: {
          kind: 'station',
          name,
          lineIds: cluster
            .map(({ line }) => line)
            .sort((a, b) => a.rank - b.rank)
            .map((line) => line.id),
        },
        geometry: { type: 'Point', coordinates: center.position.map(round) },
      });
    }
  }
  return features.sort((a, b) => compareStrings(a.id, b.id));
}

function metricDistance(a, b) {
  const [ax, ay] = toIdfMetricPlane(a);
  const [bx, by] = toIdfMetricPlane(b);
  return Math.hypot(ax - bx, ay - by);
}

function singleLinkage(members, threshold) {
  const parent = members.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (
        metricDistance(members[i].position, members[j].position) <= threshold
      ) {
        parent[find(j)] = find(i);
      }
    }
  }
  const clusters = new Map();
  members.forEach((member, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(member);
  });
  return [...clusters.values()];
}

function medoid(members) {
  let best = null;
  let bestCost = Infinity;
  for (const candidate of members) {
    let cost = 0;
    for (const other of members)
      cost += metricDistance(candidate.position, other.position) ** 2;
    if (
      cost < bestCost ||
      (cost === bestCost &&
        (candidate.position[0] - best.position[0] ||
          candidate.position[1] - best.position[1] ||
          candidate.idGares - best.idGares) < 0)
    ) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

function mostFrequentNameWithBestRankedLineTieBreak(members) {
  const counts = new Map();
  for (const { name, line } of members) {
    const entry = counts.get(name) || { count: 0, bestLineRank: Infinity };
    entry.count++;
    entry.bestLineRank = Math.min(entry.bestLineRank, line.rank);
    counts.set(name, entry);
  }
  let best = null;
  for (const [name, entry] of counts) {
    if (
      !best ||
      entry.count > best.entry.count ||
      (entry.count === best.entry.count &&
        entry.bestLineRank < best.entry.bestLineRank)
    ) {
      best = { name, entry };
    }
  }
  return best.name;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}
