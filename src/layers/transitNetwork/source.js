/** @typedef {'rer'|'train'|'metro'|'tram'|'shuttle'} TransitMode */
/** @typedef {0|1|2|3} CasingLevel 0 draws on top and narrowest. */
/**
 * @typedef {object} TransitLine
 * @property {string} id IDFM line id, e.g. 'C01743'.
 * @property {string} code 'B'
 * @property {string} name 'RER B'
 * @property {TransitMode} mode
 * @property {string} color '#5091CB'
 * @property {number} rank 0 is the highest priority.
 */
/**
 * @typedef {object} TrackStrand Every path of one line at one casing level.
 * @property {TransitLine} line
 * @property {CasingLevel} level
 * @property {number[][]} paths Flat [lon0, lat0, lon1, lat1, ...] degrees.
 */
/**
 * @typedef {object} TransitStation
 * @property {string} id 'gare:111057'
 * @property {string} name
 * @property {number} lon
 * @property {number} lat
 * @property {TransitLine[]} lines By rank, at least one.
 */
/**
 * @typedef {object} TransitNetwork
 * @property {TransitLine[]} lines By rank.
 * @property {TrackStrand[][]} strandsByLevel Index is the casing level.
 * @property {TransitStation[]} stations
 */

export const TRANSIT_MODES = Object.freeze([
  'rer',
  'train',
  'metro',
  'tram',
  'shuttle',
]);
export const MAX_CASING_LEVEL = 3;

function resolveNetworkAssetUrl() {
  return new URL(
    '../../data/local_data/idfm_transit_network/network.geojson',
    import.meta.url,
  ).href;
}

/**
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {{label: string, fetch(signal?: AbortSignal): Promise<TransitNetwork>}}
 */
export function createBundledTransitNetworkSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    label: 'Île-de-France Mobilités', // i18n-ignore: data provider name
    async fetch(signal) {
      signal?.throwIfAborted();
      const url = resolveNetworkAssetUrl();
      const response = await fetchImpl(url, { signal, cache: 'force-cache' });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const json = await response.json();
      signal?.throwIfAborted();
      return parseTransitNetwork(json);
    },
  };
}

function parseTransitNetwork(json) {
  if (json?.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    throw new TypeError('transit network: expected a FeatureCollection');
  }
  const lineFeatures = [];
  const stationFeatures = [];
  for (const feature of json.features) {
    const kind = feature?.properties?.kind;
    if (kind === 'line') lineFeatures.push(feature);
    else if (kind === 'station') stationFeatures.push(feature);
    else {
      throw new TypeError(
        `transit network: feature ${feature?.id} has unknown kind ${JSON.stringify(kind)}`,
      );
    }
  }

  /** @type {Map<string, TransitLine>} */
  const lines = new Map();
  const strandsByLevel = Array.from({ length: MAX_CASING_LEVEL + 1 }, () => []);
  for (const feature of lineFeatures) {
    const label = `transit network: line feature ${feature.id}`;
    const p = feature.properties;
    if (!TRANSIT_MODES.includes(p.mode)) {
      throw new TypeError(`${label}: unknown mode ${JSON.stringify(p.mode)}`);
    }
    if (typeof p.color !== 'string' || !/^#[0-9A-F]{6}$/.test(p.color)) {
      throw new TypeError(`${label}: bad colour ${JSON.stringify(p.color)}`);
    }
    if (
      !Number.isInteger(p.level) ||
      p.level < 0 ||
      p.level > MAX_CASING_LEVEL
    ) {
      throw new TypeError(
        `${label}: level ${p.level} outside 0..${MAX_CASING_LEVEL}`,
      );
    }
    if (typeof p.line !== 'string' || !Number.isInteger(p.rank)) {
      throw new TypeError(`${label}: missing line id or rank`);
    }
    const parsed = {
      id: p.line,
      code: String(p.code ?? ''),
      name: String(p.name ?? ''),
      mode: p.mode,
      color: p.color,
      rank: p.rank,
    };
    const known = lines.get(parsed.id);
    if (known && JSON.stringify(known) !== JSON.stringify(parsed)) {
      throw new TypeError(
        `${label}: metadata differs from another feature of ${parsed.id}`,
      );
    }
    if (!known) lines.set(parsed.id, parsed);
    if (feature.geometry?.type !== 'MultiLineString') {
      throw new TypeError(`${label}: expected a MultiLineString`);
    }
    const paths = feature.geometry.coordinates.map((path) => {
      if (!Array.isArray(path) || path.length < 2) {
        throw new TypeError(`${label}: a path has fewer than two positions`);
      }
      return path.flatMap((position) => readPosition(position, label));
    });
    strandsByLevel[p.level].push({
      line: lines.get(parsed.id),
      level: p.level,
      paths,
    });
  }

  const stations = stationFeatures.map((feature) => {
    const label = `transit network: station ${feature.id}`;
    const p = feature.properties;
    if (typeof feature.id !== 'string' || !feature.id) {
      throw new TypeError(`${label}: missing id`);
    }
    if (typeof p.name !== 'string' || !p.name.trim()) {
      throw new TypeError(`${label}: missing name`);
    }
    if (!Array.isArray(p.lineIds) || p.lineIds.length === 0) {
      throw new TypeError(`${label}: serves no line`);
    }
    const stationLines = p.lineIds.map((id) => {
      const line = lines.get(id);
      if (!line)
        throw new TypeError(`${label}: unknown line ${JSON.stringify(id)}`);
      return line;
    });
    if (feature.geometry?.type !== 'Point') {
      throw new TypeError(`${label}: expected a Point`);
    }
    const [lon, lat] = readPosition(feature.geometry.coordinates, label);
    return {
      id: feature.id,
      name: p.name,
      lon,
      lat,
      lines: stationLines.sort((a, b) => a.rank - b.rank),
    };
  });

  return {
    lines: [...lines.values()].sort((a, b) => a.rank - b.rank),
    strandsByLevel,
    stations,
  };
}

function readPosition(position, label) {
  const [lon, lat] = Array.isArray(position) ? position : [];
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  ) {
    throw new TypeError(
      `${label}: invalid position ${JSON.stringify(position)}`,
    );
  }
  return [lon, lat];
}
