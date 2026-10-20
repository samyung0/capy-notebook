import { expect, it } from 'vitest';
import {
  type PresenceConnection,
  presenceNames,
  presencePeople,
  readPresence,
} from './presence';

const connection = (
  person: number,
  browser: string,
  os: string,
  clients: number[] = []
): PresenceConnection => ({
  avatar: null,
  browser,
  clients,
  name: `Person ${person}`,
  os,
  person,
});

it('reads the room’s presence and nothing else', () => {
  const sent = JSON.stringify({
    connections: [
      {
        avatar: '/icons/waves-01.svg',
        browser: 'Chrome',
        clients: [7, 'x'],
        name: 'Bob',
        os: null,
        person: 2,
      },
      { name: 'no person' },
    ],
    type: 'room-presence',
  });
  expect(readPresence(sent)).toEqual([
    {
      avatar: '/icons/waves-01.svg',
      browser: 'Chrome',
      clients: [7],
      name: 'Bob',
      os: null,
      person: 2,
    },
  ]);
  expect(readPresence('{"type":"open-slowed"}')).toBeNull();
  expect(readPresence('{"type":"room-presence"')).toBeNull();
});

it('groups connections into people with each device once, and names client ids', () => {
  const connections = [
    connection(1, 'Chrome', 'Windows', [11]),
    connection(2, 'Safari', 'iOS', [12]),
    connection(1, 'Safari', 'iOS', [13]),
    connection(1, 'Chrome', 'Windows', [14]),
  ];
  expect(
    presencePeople(connections).map(({ devices, person }) => ({
      devices,
      person,
    }))
  ).toEqual([
    {
      devices: [
        { browser: 'Chrome', os: 'Windows' },
        { browser: 'Safari', os: 'iOS' },
      ],
      person: 1,
    },
    { devices: [{ browser: 'Safari', os: 'iOS' }], person: 2 },
  ]);
  expect([...presenceNames(connections)]).toEqual([
    [11, 'Person 1'],
    [12, 'Person 2'],
    [13, 'Person 1'],
    [14, 'Person 1'],
  ]);
});
