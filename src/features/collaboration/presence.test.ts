import { expect, it } from 'vitest';
import {
  type PresenceConnection,
  presenceNames,
  presencePeople,
  readPresence,
} from './presence';

const connection = (
  person: number,
  clients: number[] = []
): PresenceConnection => ({
  avatar: null,
  clients,
  name: `Person ${person}`,
  person,
});

it('reads the room’s presence and nothing else', () => {
  const sent = JSON.stringify({
    connections: [
      {
        avatar: '/icons/waves-01.svg',
        clients: [7, 'x'],
        name: 'Bob',
        person: 2,
      },
      { name: 'no person' },
    ],
    type: 'room-presence',
  });
  expect(readPresence(sent)).toEqual([
    {
      avatar: '/icons/waves-01.svg',
      clients: [7],
      name: 'Bob',
      person: 2,
    },
  ]);
  expect(readPresence('{"type":"open-slowed"}')).toBeNull();
  expect(readPresence('{"type":"room-presence"')).toBeNull();
});

it('groups connections into people, one each, and names client ids', () => {
  const connections = [
    connection(1, [11]),
    connection(2, [12]),
    connection(1, [13]),
    connection(1, [14]),
  ];
  expect(presencePeople(connections).map(({ person }) => person)).toEqual([
    1, 2,
  ]);
  expect([...presenceNames(connections)]).toEqual([
    [11, 'Person 1'],
    [12, 'Person 2'],
    [13, 'Person 1'],
    [14, 'Person 1'],
  ]);
});
