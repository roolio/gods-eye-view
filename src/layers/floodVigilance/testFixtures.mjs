import * as Cesium from 'cesium';

// Node has no WebGL context; GroundPolylinePrimitive validates its 1 px
// render-state line width against these limits at construction.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 1;

/** Minimal viewer: ground primitives, a scripted pick and a click seam. */
export function fakeViewer({ heightM = 900_000, lon = 2.35, lat = 46.5 } = {}) {
  const renders = { count: 0 };
  const viewer = {
    picked: null,
    renders,
    scene: {
      groundPrimitives: new Cesium.PrimitiveCollection(),
      primitives: new Cesium.PrimitiveCollection(),
      globe: { show: true, ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick: () => viewer.picked,
      requestRender() {
        renders.count++;
      },
    },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, heightM),
      moveEnd: new Cesium.Event(),
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(1.6, 50.7),
    },
  };
  return viewer;
}

/** Records overlay-host calls as [verb, sourceId, titles|visible]. */
export function recordingHost() {
  const calls = [];
  return {
    calls,
    entries: new Map(),
    setVisible(id, visible) {
      calls.push(['visible', id, visible]);
    },
    setEntries(id, entries) {
      this.entries.set(id, entries);
      calls.push(['entries', id, entries.map((entry) => entry.title)]);
    },
    clearSource(id) {
      this.entries.delete(id);
      calls.push(['clear', id]);
    },
  };
}

/** A ScreenSpaceEventHandler stand-in that exposes the registered click. */
export function clickSeam() {
  const seam = { handlers: 0, destroyed: 0, click: null };
  seam.factory = () => {
    seam.handlers++;
    return {
      setInputAction(action) {
        seam.click = action;
      },
      destroy() {
        seam.destroyed++;
        seam.click = null;
      },
    };
  };
  return seam;
}

export const picking = {
  resolvePickId: (picked) => picked?.id ?? null,
  isOwnedByOtherLayer: (layerId, id) => id.startsWith('other:'),
};
