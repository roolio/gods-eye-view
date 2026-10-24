/** Card models for a selected river section or gauge. Pure: no Cesium types. */
import {
  formatDate,
  formatNumber,
  formatRelativeTime,
  t,
} from '../../i18n/index.js';
import {
  STATION_STALE_AFTER_MS,
  stationIsStale,
  stationObservedAt,
  vigilanceLevel,
} from './records.js';
import { stationPointStyle } from './style.js';

export const FLOOD_CARD_SOURCE_ID = 'flood-vigilance-card';

const UTC_TIME = Object.freeze({
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "24 Oct, 07:55" in the UI language, always UTC. */
export function formatUtcTime(ms) {
  return Number.isFinite(ms) ? formatDate(ms, UTC_TIME) : '';
}

/** Layout shared by every card of this layer; the caller adds `position`. */
const CARD_LAYOUT = Object.freeze({
  selected: true,
  interactive: false,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * @param {import('./records.js').FloodSection} section
 * @param {{publishedAt: number|null}} bulletin
 * @returns {object} World-overlay entry without `position`.
 */
export function buildSectionCard(section, { publishedAt }) {
  const level = vigilanceLevel(section.level);
  return {
    ...CARD_LAYOUT,
    id: `flood-vigilance-card:section:${section.id}`,
    title: t('FLOOD VIGILANCE · {name}', { name: section.name }),
    details: [
      t(level.label),
      publishedAt
        ? t('Vigicrues bulletin {time} UTC', {
            time: formatUtcTime(publishedAt),
          })
        : t('Vigicrues bulletin time unavailable'),
      t('Section {id}', { id: section.id }),
    ],
    accent: level.color,
  };
}

const metres = (value) =>
  formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function trendText(trend) {
  if (!trend) return t('no reading an hour earlier to compare');
  const minutes = Math.round(trend.spanMs / 60_000);
  const delta = metres(Math.abs(trend.deltaM));
  if (trend.direction === 'rising')
    return t('rising {delta} m in {minutes} min', { delta, minutes });
  if (trend.direction === 'falling')
    return t('falling {delta} m in {minutes} min', { delta, minutes });
  return t('steady over {minutes} min', { minutes });
}

function provenanceText(reading) {
  if (reading.method && reading.qualification)
    return t('Method: {method} · Qualification: {qualification}', {
      method: reading.method,
      qualification: reading.qualification,
    });
  if (reading.method) return t('Method: {method}', { method: reading.method });
  if (reading.qualification)
    return t('Qualification: {qualification}', {
      qualification: reading.qualification,
    });
  return null;
}

/**
 * Hub'Eau values stay as sent (method and qualification are French labels);
 * the wording around them translates.
 * @param {import('./records.js').StationReading} station
 * @param {number} nowMs
 * @returns {object} World-overlay entry without `position`.
 */
export function buildStationCard(station, nowMs) {
  const stale = stationIsStale(station, nowMs);
  const observedAt = stationObservedAt(station);
  const details = [];
  if (station.height)
    details.push(
      `${t('Height {value} m', { value: metres(station.height.value) })} · ${trendText(station.trend)}`,
    );
  if (station.flow)
    details.push(
      t('Flow {value} m³/s', {
        value: formatNumber(station.flow.value, {
          maximumFractionDigits: station.flow.value < 10 ? 2 : 1,
        }),
      }),
    );
  if (observedAt !== null) {
    details.push(
      t('Measured {time} UTC ({age})', {
        time: formatUtcTime(observedAt),
        age: formatRelativeTime(
          -Math.max(0, Math.round((nowMs - observedAt) / 60_000)),
          'minute',
        ),
      }),
    );
    const provenance = provenanceText(station.height ?? station.flow);
    if (provenance) details.push(provenance);
  }
  if (stale)
    details.push(
      t('No reading in the last {hours} hours', {
        hours: STATION_STALE_AFTER_MS / 3600_000,
      }),
    );
  details.push(t("Hub'Eau station {id}", { id: station.id }));
  return {
    ...CARD_LAYOUT,
    id: `flood-vigilance-card:station:${station.id}`,
    title: t('GAUGE · {name}', { name: station.name }),
    details,
    accent: stationPointStyle(stale).fill,
  };
}
