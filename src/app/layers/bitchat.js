import { createBitchatLayer } from '../../layers/bitchat/index.js';

/** Construct the optional public activity layer. */
export function createApplicationBitchat(options) {
  return createBitchatLayer(options);
}
