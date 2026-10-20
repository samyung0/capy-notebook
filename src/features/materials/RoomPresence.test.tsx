import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  createPresenceStore,
  type PresenceConnection,
  presencePeople,
} from '@/features/collaboration/presence';
import { PresenceCard, RoomPresence } from './RoomPresence';

const connection = (
  person: number,
  browser: string | null,
  os: string | null
): PresenceConnection => ({
  avatar: null,
  browser,
  clients: [],
  name: `Person ${person}`,
  os,
  person,
});

function render(connections: PresenceConnection[]) {
  const store = createPresenceStore();
  store.getState().report(connections);
  return renderToStaticMarkup(<RoomPresence store={store} />);
}

/** At most three avatars, then +N (Epo 2026-10-20). */
it('shows three avatars and counts the rest', () => {
  const html = render(
    [1, 2, 3, 4, 5].map((person) => connection(person, 'Chrome', 'Windows'))
  );
  expect(html.match(/data-presence-person=/g)).toHaveLength(3);
  expect(html).toContain('data-presence-more="2"');
  expect(html).toContain('+2');
  expect(render([connection(1, 'Chrome', 'Windows')])).not.toContain(
    'data-presence-more'
  );
});

/** The room never lists this tab, so the user's own avatar shows only while
 * another tab or device of theirs has the document open, labelled with it. */
it('shows the user only for another tab or device, with that device', () => {
  expect(render([])).toBe('');
  const elsewhere = [connection(7, 'Safari', 'iOS')];
  expect(render(elsewhere)).toContain('data-presence-person="7"');
  const [me] = presencePeople(elsewhere);
  expect(renderToStaticMarkup(<PresenceCard person={me} />)).toContain(
    'Safari on iOS'
  );
});

/** An avatar's hover lists the person's devices, each once. */
it('lists each device of a person on hover', () => {
  const [ann] = presencePeople([
    connection(1, 'Chrome', 'Windows'),
    connection(1, 'Chrome', 'Windows'),
    connection(1, 'Firefox', null),
    connection(1, null, null),
  ]);
  const card = renderToStaticMarkup(<PresenceCard person={ann} />);
  expect(card).toContain('Person 1');
  expect(card.match(/Chrome on Windows/g)).toHaveLength(1);
  expect(card).toContain('Firefox');
  expect(card).toContain('Unknown device');
});
