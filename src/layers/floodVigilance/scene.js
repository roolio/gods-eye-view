import * as Cesium from 'cesium';
import { FLOOD_VIGILANCE_LAYER_ID } from './records.js';
import { sectionLineStyle } from './style.js';

export const SECTION_PICK_PREFIX = `${FLOOD_VIGILANCE_LAYER_ID}:section:`;

/**
 * Ground polylines for the river sections, one primitive per level. Add order
 * is draw order, so red is drawn last and on top.
 * @param {Cesium.Viewer} viewer
 * @param {import('./records.js').FloodSection[]} sections
 * @param {{classificationType: Cesium.ClassificationType}} options
 * @returns {{setSurface(type: Cesium.ClassificationType): void, dispose(): void}}
 */
export function createSectionScene(viewer, sections, { classificationType }) {
  const scene = viewer.scene;
  const collection = scene.groundPrimitives.add(
    new Cesium.PrimitiveCollection(),
  );
  const primitives = [];
  for (const level of [1, 2, 3, 4]) {
    const style = sectionLineStyle(level);
    const color = Cesium.Color.fromCssColorString(style.color).withAlpha(
      style.alpha,
    );
    const instances = [];
    for (const section of sections) {
      if (section.level !== level) continue;
      for (const path of section.paths) {
        instances.push(
          new Cesium.GeometryInstance({
            id: `${SECTION_PICK_PREFIX}${section.id}`,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(path),
              width: style.widthPx,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
            },
          }),
        );
      }
    }
    if (!instances.length) continue;
    primitives.push(
      collection.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances,
          appearance: new Cesium.PolylineColorAppearance({
            translucent: style.alpha < 1,
          }),
          classificationType,
        }),
      ),
    );
  }
  let disposed = false;
  return {
    setSurface(type) {
      for (const primitive of primitives) primitive.classificationType = type;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (viewer.isDestroyed?.()) return;
      if (!scene.groundPrimitives.isDestroyed?.())
        scene.groundPrimitives.remove(collection);
      else if (!collection.isDestroyed?.()) collection.destroy();
    },
  };
}
