import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';

/**
 * A scene object on the stub renderer, the eye straight down over
 * `lon, lat` at `heightM`. Clicks pick the hit in `picked` (a hit of
 * `hitOf`, or another layer's), and the camera reports `viewRectangle`
 * (`[west, south, east, north]`, degrees) or, without one, no rectangle.
 */
export function fakeViewer({
  heightM = 900_000,
  lon = 2.35,
  lat = 46.5,
  viewRectangle = null,
} = {}) {
  const renderer = createStubRenderer();
  const viewer = {
    picked: null,
    renderer,
    /** Move the eye to `height`, over the same point. */
    setHeight(height) {
      renderer.camera.setView({ destination: { lon, lat, height } });
    },
    /** A click at `(x, y)`, as the input port raises it. */
    click(x = 10, y = 10) {
      renderer.testing.pointer('click', x, y);
    },
  };
  bindRenderer(viewer, renderer);
  viewer.setHeight(heightM);
  const [west, south, east, north] = viewRectangle ?? [];
  renderer.camera.viewRectangle = () =>
    viewRectangle ? { west, south, east, north } : null;
  renderer.testing.scriptPicks(() => (viewer.picked ? [viewer.picked] : []));
  return viewer;
}

/** The live draw sets whose id starts with `prefix`, in the order made. */
export function setsOf(viewer, prefix) {
  const testing = viewer.renderer.testing;
  return testing
    .sets()
    .filter((id) => id.startsWith(prefix))
    .map((id) => ({ id, ...testing.setRecord(id) }));
}

/** The hit of the drawn item `id`, as a pick of it answers. */
export function hitOf(viewer, id) {
  for (const set of setsOf(viewer, '')) {
    const item = set.items.get(id);
    if (item) return { set: set.id, id, meta: item.meta, surface: false };
  }
  throw new Error(`No drawn item ${id}`);
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

export function fakePicking() {
  const owners = new Map();
  return {
    owners,
    resolvePickId: (picked) => picked?.id ?? null,
    isOwnedByOtherLayer: (layerId, id) => id.startsWith('other:'),
    registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
    unregisterPickOwner: (layerId) => owners.delete(layerId),
  };
}
