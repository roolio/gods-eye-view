/** Card model for one selected news-event location. Pure: no Cesium types. */
import { formatNumber, t, tn } from '../../i18n/index.js';
import { NEWS_EVENT_CATEGORIES } from './records.js';

export const NEWS_EVENTS_OVERLAY_SOURCE_ID = 'news-events';

/** Events listed on a card; the rest stay in the analyst records. */
const CARD_EVENT_LINES = 3;

/** CSS color per display category (marker fill and card accent). */
export const NEWS_EVENT_COLORS = Object.freeze({
  violence: '#ff3b30',
  protest: '#ffb300',
  coercion: '#ff7a00',
  tension: '#b388ff',
});

/** Category name in the UI language. */
export function newsEventCategoryLabel(category) {
  switch (category) {
    case 'violence':
      return t('Violence', { context: 'news event' });
    case 'protest':
      return t('Protest', { context: 'news event' });
    case 'coercion':
      return t('Coercion', { context: 'news event' });
    case 'tension':
      return t('Tension', { context: 'news event' });
    default:
      return category;
  }
}

/** Compact age, "5m" / "3h" / "2d", in the UI language. */
function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(deltaMs / 60000)),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}

/** "Police → Protester", "Police", or null. */
function actorsLine(event) {
  if (event.actor1 && event.actor2) return `${event.actor1} → ${event.actor2}`;
  return event.actor1 || event.actor2 || null;
}

/** GDELT place names repeat the region ("Gaza, Israel (general), Israel"). */
export function shortPlaceName(place) {
  const parts = String(place ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const country = parts.at(-1);
  return parts.length > 1 && parts[0] !== country
    ? `${parts[0]}, ${country}`
    : parts[0];
}

/**
 * Build the overlay-host entry for one selected location. The caller supplies
 * `position` (Cartesian) separately; this model stays JSON-safe for tests.
 * @param {Object} row - Normalized location row (see records.js).
 * @param {number} nowMs - Current epoch milliseconds.
 * @param {{link: ?string}} [extras] - Article opened by a click on the card.
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildNewsEventCard(row, nowMs, { link = null } = {}) {
  const details = [
    tn(
      row.articleCount,
      '{count} article in 24 h',
      '{count} articles in 24 h',
      { count: formatNumber(row.articleCount) },
    ),
  ];
  const breakdown = NEWS_EVENT_CATEGORIES.filter(
    (category) => row.categories[category] > 0,
  ).map(
    (category) =>
      `${newsEventCategoryLabel(category)} ${formatNumber(row.categories[category])}`,
  );
  if (breakdown.length) details.push(breakdown.join(' · '));
  for (const event of row.events.slice(0, CARD_EVENT_LINES)) {
    const parts = [newsEventCategoryLabel(event.category)];
    const actors = actorsLine(event);
    if (actors) parts.push(actors);
    if (event.domain) parts.push(event.domain);
    const age = formatAge(nowMs - event.timeMs);
    if (event.timeMs != null && age) parts.push(t('{age} ago', { age }));
    details.push(parts.join(' · '));
  }
  details.push(t('Machine-coded media reports, not verified incidents'));
  if (link) details.push(t('Top article ↗ · click card to open'));

  const title = t('NEWS · {place}', {
    place: shortPlaceName(row.place) || t('Unnamed place'),
  });
  return {
    id: `news-events-card:${row.stableId}`,
    // `selected` picks the paint lane and collision protection.
    selected: true,
    // Only a linked card is clickable: the overlay host registers hit
    // rectangles solely for interactive entries.
    interactive: Boolean(link),
    ...(link
      ? { accessibilityLabel: t('Open the top article for {title}', { title }) }
      : undefined),
    title,
    details,
    accent: NEWS_EVENT_COLORS[row.dominant] ?? NEWS_EVENT_COLORS.tension,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
