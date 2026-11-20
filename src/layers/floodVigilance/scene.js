import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { drawOf } from '../../render/rendererOf.js';
import { FLOOD_VIGILANCE_LAYER_ID } from './records.js';
import { sectionLineStyle } from './style.js';

export const SECTION_PICK_PREFIX = `${FLOOD_VIGILANCE_LAYER_ID}:section:`;
/** Draw set ids start with this, one set per level: `<prefix>:<n>:level-<level>`. */
export const SECTION_SET_PREFIX = `${FLOOD_VIGILANCE_LAYER_ID}:sections`;

let scenes = 0;

/** Packed ECEF `x, y, z` of a `[lon, lat, lon, lat, ...]` path in degrees. */
function pathPositions(path) {
  const positions = new Float64Array((path.length / 2) * 3);
  for (let i = 0, j = 0; i < path.length; i += 2, j += 3) {
    const p = fromDegrees(path[i], path[i + 1]);
    positions[j] = p.x;
    positions[j + 1] = p.y;
    positions[j + 2] = p.z;
  }
  return positions;
}

/**
 * Draped lines for the river sections, one draw set per level. Sets of one
 * draw order stack in the order they are made: green first, so red is drawn
 * last and on top.
 * Each path is an item `<SECTION_PICK_PREFIX><section id>:<path index>` whose
 * `meta` names its section.
 * @param {object} viewer The scene object the renderer draws.
 * @param {import('./records.js').FloodSection[]} sections
 * @param {{clampTo: 'tiles'|'terrain'|'both'}} options
 * @returns {{setIds: Set<string>, setSurface(clampTo: 'tiles'|'terrain'|'both'): void, dispose(): void}}
 */
export function createSectionScene(viewer, sections, { clampTo }) {
  const draw = drawOf(viewer);
  const prefix = `${SECTION_SET_PREFIX}:${++scenes}`;
  const sets = [];
  for (const level of [1, 2, 3, 4]) {
    const style = sectionLineStyle(level);
    const color = hexColor(style.color, style.alpha);
    const items = [];
    for (const section of sections) {
      if (section.level !== level) continue;
      section.paths.forEach((path, index) => {
        items.push({
          id: `${SECTION_PICK_PREFIX}${section.id}:${index}`,
          positions: pathPositions(path),
          widthPx: style.widthPx,
          mode: 'draped',
          style: { kind: 'solid', color },
          meta: { kind: 'section', id: section.id },
        });
      });
    }
    if (!items.length) continue;
    const set = draw.lines({
      id: `${prefix}:level-${level}`,
      clampTo,
    });
    set.set(items);
    sets.push(set);
  }
  let disposed = false;
  return {
    setIds: new Set(sets.map((set) => set.id)),
    setSurface(next) {
      for (const set of sets) set.setOptions({ clampTo: next });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const set of sets) set.dispose();
    },
  };
}
