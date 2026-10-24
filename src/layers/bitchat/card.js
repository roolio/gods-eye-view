import { t } from '../../i18n/index.js';

/** A transient card that treats public messages as text, never markup. */
export function showBitchatCard(container, cell, data, now = Date.now()) {
  const card = document.createElement('section');
  card.className = 'bitchat-card';
  card.setAttribute('aria-label', t('Bitchat activity'));
  Object.assign(card.style, {
    position: 'absolute',
    right: '20px',
    bottom: '80px',
    width: '320px',
    maxHeight: '55vh',
    overflow: 'auto',
    padding: '16px',
    background: '#101b28',
    color: '#eef5fa',
    border: '1px solid #70bea6',
    borderRadius: '8px',
    zIndex: '50',
    font: '14px sans-serif',
  });
  const add = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    card.append(node);
    return node;
  };
  const close = add('button', t('Close'));
  close.style.float = 'right';
  close.onclick = () => card.remove();
  add('h3', t('Bitchat activity'));
  add(
    'p',
    t('Cell {cell} · {people} people · {messages} messages', {
      cell: cell.geohash,
      people: data.people,
      messages: cell.messages,
    }),
  );
  add(
    'p',
    t(
      'Public messages from Bitchat location channels, shown live and not stored.',
    ),
  );
  if (!data.messages.length) add('p', t('No public messages available.'));
  for (const { text, at } of data.messages) {
    add('p', text);
    add(
      'small',
      t('{minutes} min ago', {
        minutes: Math.max(0, Math.floor((now / 1000 - at) / 60)),
      }),
    );
  }
  container.append(card);
  return () => card.remove();
}
