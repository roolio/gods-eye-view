import * as Cesium from 'cesium';
import { createFloodVigilanceLayer } from '../../layers/floodVigilance/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Wire Vigicrues flood vigilance into the application catalog. */
export function createApplicationFloodVigilance(options) {
  return createFloodVigilanceLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
