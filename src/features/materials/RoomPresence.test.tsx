import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  createPresenceStore,
  type PresenceConnection,
} from '@/features/collaboration/presence';
import { RoomPresence } from './RoomPresence';

const connection = (person: number): PresenceConnection => ({
  avatar: null,
  clients: [],
  name: `Person ${person}`,
  person,
});

function render(connections: PresenceConnection[]) {
  const store = createPresenceStore();
  store.getState().report(connections);
  return renderToStaticMarkup(<RoomPresence store={store} />);
}

/** At most three avatars, then +N (Epo 2026-10-20). */
it('shows three avatars and counts the rest', () => {
  const html = render([1, 2, 3, 4, 5].map(connection));
  expect(html.match(/data-presence-person=/g)).toHaveLength(3);
  expect(html).toContain('data-presence-more="2"');
  expect(html).toContain('+2');
  expect(render([connection(1)])).not.toContain('data-presence-more');
});

/** One avatar per person; the room never lists this tab, so the user's own
 * avatar shows only while another tab or device of theirs has the document
 * open. */
it('shows a person once and the user only for another tab or device', () => {
  expect(render([])).toBe('');
  const html = render([connection(7), connection(7)]);
  expect(html.match(/data-presence-person="7"/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Person 7"');
});
