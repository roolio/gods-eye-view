/** Card models for a selected river section. Pure: no Cesium types. */
import { formatDate, t } from '../../i18n/index.js';
import { vigilanceLevel } from './records.js';

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
