import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createEcccAirQualitySource } from '../layers/airQuality/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createBitchatSource } from '../layers/bitchat/source.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';
import { createBundledTransitNetworkSource } from '../layers/transitNetwork/source.js';
import { createFloodVigilanceSource } from '../layers/floodVigilance/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'air-quality': createEcccAirQualitySource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
    'transit-network': createBundledTransitNetworkSource(),
    'flood-vigilance': createFloodVigilanceSource(),
    bitchat: createBitchatSource(),
  };
}
