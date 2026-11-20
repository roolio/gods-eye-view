import { createFloodVigilanceLayer } from '../../layers/floodVigilance/index.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';

/** Wire Vigicrues flood vigilance into the application catalog. */
export function createApplicationFloodVigilance(options) {
  return createFloodVigilanceLayer({
    overlayHost,
    picking,
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
