import { useEffect } from 'react';
import { createStore, type StoreApi } from 'zustand';

/**
 * The room's presence (Epo 2026-10-20), a stateless message the collaboration
 * server sends the room's editors when it changes (`PRESENCE_TYPE`,
 * collaboration-rs/crates/server/src/room.rs): the other connections of
 * people who can edit, each with the name, avatar and device its signed token
 * carries and the awareness client ids that name its cursor, and its person's
 * number in the room (never a user id), which groups a person's tabs and
 * devices. A member's own
 * connection is never listed, so its user shows only for their other tabs and
 * devices. Labels come from here, never from what a peer's awareness says.
 */
export const PRESENCE_TYPE = 'room-presence';

export interface PresenceConnection {
  avatar: string | null;
  browser: string | null;
  clients: number[];
  name: string | null;
  os: string | null;
  person: number;
}

export interface PresenceDevice {
  browser: string | null;
  os: string | null;
}

/** One avatar per person, with each device they have the room open on. */
export interface PresencePerson {
  avatar: string | null;
  devices: PresenceDevice[];
  name: string | null;
  person: number;
}

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** The connections of a presence message; null for any other message. */
export function readPresence(payload: string): PresenceConnection[] | null {
  if (!payload.includes(PRESENCE_TYPE)) return null;
  let message: { connections?: unknown; type?: unknown };
  try {
    message = JSON.parse(payload);
  } catch {
    return null;
  }
  if (message.type !== PRESENCE_TYPE || !Array.isArray(message.connections))
    return null;
  return message.connections.flatMap((entry: Record<string, unknown>) =>
    entry && typeof entry.person === 'number'
      ? [
          {
            avatar: text(entry.avatar),
            browser: text(entry.browser),
            clients: Array.isArray(entry.clients)
              ? entry.clients.filter(
                  (client): client is number => typeof client === 'number'
                )
              : [],
            name: text(entry.name),
            os: text(entry.os),
            person: entry.person,
          },
        ]
      : []
  );
}

/** The people in the room, in the order the server lists their first
 * connection; a device shows once however many tabs it has open. */
export function presencePeople(
  connections: readonly PresenceConnection[]
): PresencePerson[] {
  const people = new Map<number, PresencePerson>();
  for (const connection of connections) {
    const person = people.get(connection.person) ?? {
      avatar: connection.avatar,
      devices: [],
      name: connection.name,
      person: connection.person,
    };
    people.set(connection.person, person);
    const known = person.devices.some(
      (device) =>
        device.browser === connection.browser && device.os === connection.os
    );
    if (!known)
      person.devices.push({ browser: connection.browser, os: connection.os });
  }
  return [...people.values()];
}

/** The verified name of each awareness client id, for cursor labels. */
export function presenceNames(
  connections: readonly PresenceConnection[]
): Map<number, string> {
  const names = new Map<number, string>();
  for (const connection of connections)
    if (connection.name)
      for (const client of connection.clients)
        names.set(client, connection.name);
  return names;
}

export const NO_PRESENCE: PresenceConnection[] = [];

/** A pane's room presence, as a store so a change re-renders only what
 * shows it (the header's avatar group, an editor's cursor labels). */
export type PresenceStore = StoreApi<{
  connections: PresenceConnection[];
  report: (connections: PresenceConnection[] | null) => void;
}>;

export const createPresenceStore = (): PresenceStore =>
  createStore((set) => ({
    connections: NO_PRESENCE,
    report: (connections) => set({ connections: connections ?? NO_PRESENCE }),
  }));

/** Hands an editor's room presence to the header while it is mounted. */
export function useReportPresence(
  report: ((connections: PresenceConnection[] | null) => void) | undefined,
  connections: PresenceConnection[]
) {
  useEffect(() => {
    report?.(connections);
  }, [report, connections]);
  useEffect(() => () => report?.(null), [report]);
}
