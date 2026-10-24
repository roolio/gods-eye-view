import { createTransitNetworkLayer } from '../../layers/transitNetwork/index.js';
import { overlayHost } from './overlayHost.js';
export function createApplicationTransitNetwork(options) {
  return createTransitNetworkLayer({
    overlayHost,
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
