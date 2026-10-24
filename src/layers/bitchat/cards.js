import { formatRelativeTime, t } from '../../i18n/index.js';

export const BITCHAT_CARD_SOURCE_ID = 'bitchat-card';

/** Anonymous public text for the shared world-overlay card renderer. */
export function buildBitchatCard(cell, data, now = Date.now()) {
  const details = [
    t('{people} people · {messages} messages', {
      people: data.people,
      messages: cell.messages,
    }),
  ];
  if (!data.messages.length) details.push(t('No public messages available.'));
  for (const { text, at } of data.messages.slice(0, 5)) {
    const chars = Array.from(text);
    const excerpt =
      chars.length > 140 ? `${chars.slice(0, 139).join('')}…` : text;
    const minutes = Math.max(0, Math.floor((now / 1000 - at) / 60));
    details.push(`${excerpt} · ${formatRelativeTime(-minutes, 'minute')}`);
  }
  details.push(
    t(
      'Public messages from Bitchat location channels, shown live and not stored.',
    ),
  );
  return {
    id: `${BITCHAT_CARD_SOURCE_ID}:${cell.geohash}`,
    title: t('BITCHAT · {cell}', { cell: cell.geohash }),
    details,
    selected: true,
    interactive: false,
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
    accent: '#70bea6',
  };
}
