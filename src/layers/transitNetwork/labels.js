export const STATION_LABEL_SOURCE_ID = 'transit-network:stations';
export const STATION_LABEL_MAX_CAMERA_HEIGHT_M = 12000;
export const STATION_LABEL_MAX_DISTANCE_M = 25000;
export const STATION_LABEL_COHORT = 48;

const AMBIENT_LABEL_DOMAIN_SHARE = 24;

const SOURCE_OPTIONS = Object.freeze({
  cohortLimit: STATION_LABEL_COHORT,
  collisionCapacity: AMBIENT_LABEL_DOMAIN_SHARE,
  maxVisible: 24,
  moving: false,
});

/**
 * @typedef {object} StationLabelRecord Owned by scene.js, refreshed per sweep.
 * @property {import('./source.js').TransitStation} station
 * @property {object} entry Stable overlay entry from createStationOverlayEntry.
 * @property {boolean} visible Dot shown and inside the camera frustum.
 * @property {number} distanceM Camera to station.
 */

const isHeavyRail = (record) =>
  record.station.lines.some(
    (line) => line.mode === 'rer' || line.mode === 'train',
  );

function compareRecords(a, b) {
  return (
    a.distanceM - b.distanceM ||
    b.station.lines.length - a.station.lines.length ||
    Number(isHeavyRail(b)) - Number(isHeavyRail(a)) ||
    (a.station.id < b.station.id ? -1 : a.station.id > b.station.id ? 1 : 0)
  );
}

/**
 * Nearest visible stations within reach, none once the camera is high.
 * @param {StationLabelRecord[]} records
 * @param {number} cameraHeightM Camera height above the ellipsoid.
 * @returns {StationLabelRecord[]} At most STATION_LABEL_COHORT, best first.
 */
export function selectStationLabelWinners(records, cameraHeightM) {
  if (!(cameraHeightM < STATION_LABEL_MAX_CAMERA_HEIGHT_M)) return [];
  return records
    .filter(
      (record) =>
        record.visible && record.distanceM <= STATION_LABEL_MAX_DISTANCE_M,
    )
    .sort(compareRecords)
    .slice(0, STATION_LABEL_COHORT);
}

/**
 * One host entry per station, created once. `position` is the station's
 * mutable anchor, so a height update moves the label without a republish.
 * @param {import('./source.js').TransitStation} station
 * @param {object} position Cesium.Cartesian3 shared with the station dot.
 * @returns {object}
 */
export function createStationOverlayEntry(station, position) {
  return {
    id: station.id,
    position,
    variant: 'label',
    title: station.name,
    accent: station.lines.length === 1 ? station.lines[0].color : '#FFFFFF',
    priority: 0,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    minDistance: 0,
    maxDistance: STATION_LABEL_MAX_DISTANCE_M,
    distanceFadeStartRatio: 0.7,
    altitudeFadeStart: 8000,
    altitudeFadeEnd: STATION_LABEL_MAX_CAMERA_HEIGHT_M,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 10,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Bind station labels to the host. publish() reaches the host only when the
 * ordered winner list changed; hide() clears the source and forgets the
 * last list, so the next show() and publish() always repaint.
 * @param {{host: {setVisible: Function, setEntries: Function, clearSource: Function},
 *   sourceId?: string}} deps
 * @returns {{show(): void, publish(winners: StationLabelRecord[]): void,
 *   hide(): void, count(): number}}
 */
export function createStationLabelPublisher({
  host,
  sourceId = STATION_LABEL_SOURCE_ID,
}) {
  let visible = false;
  let signature = null;
  let published = 0;
  return {
    show() {
      if (visible) return;
      visible = true;
      host.setVisible(sourceId, true);
    },
    publish(winners) {
      if (!visible) return;
      const next = winners.map((record) => record.station.id).join('\n');
      if (next === signature) return;
      signature = next;
      winners.forEach((record, index) => {
        record.entry.priority = 1000 - index;
      });
      host.setEntries(
        sourceId,
        winners.map((record) => record.entry),
        SOURCE_OPTIONS,
      );
      published = winners.length;
    },
    hide() {
      if (signature !== null) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      signature = null;
      published = 0;
    },
    count() {
      return published;
    },
  };
}
