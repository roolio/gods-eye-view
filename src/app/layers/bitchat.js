import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';
import { createBitchatLayer } from '../../layers/bitchat/index.js';

/** Construct the optional public activity layer. */
export function createApplicationBitchat(options) {
  return createBitchatLayer({
    overlayHost,
    picking,
    ...options,
  });
}
