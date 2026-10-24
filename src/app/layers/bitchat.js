import * as Cesium from 'cesium';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';
import { createBitchatLayer } from '../../layers/bitchat/index.js';

/** Construct the optional public activity layer. */
export function createApplicationBitchat(options) {
  return createBitchatLayer({
    overlayHost,
    picking,
    pointer: { isPointerFree },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    ...options,
  });
}
