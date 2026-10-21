import { expect, it } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createOfficeCursors, officePeers } from './officeCursors';

const cell = { anchor: { col: 1, row: 2 }, head: { col: 1, row: 2 } };

/** Security regression (Epo 2026-10-20): an Office cursor is labelled with
 * the verified name the room's presence gives its client id, never the name
 * a peer puts in its own awareness; an id the presence does not list (a
 * reader) and a malformed cursor are not drawn. Fails if a label is read
 * from awareness. */
it('labels a cursor from the presence, never from awareness', () => {
  const states = new Map<number, unknown>([
    [1, { cursor: { ...cell, sheet: 'S1' }, user: { name: 'Mallory' } }],
    [2, { cursor: { ...cell, sheet: 'S1' }, name: 'Rae' }],
    [3, { cursor: { sheet: 'S1' } }],
    [9, { cursor: { slideId: 's1' } }],
  ]);
  const names = new Map([
    [1, 'Peer'],
    [3, 'Cal'],
    [9, 'Me'],
  ]);
  expect(officePeers(states, 9, names)).toEqual([
    { clientId: 1, cursor: { ...cell, sheet: 'S1' }, name: 'Peer' },
  ]);
});

it('follows the room’s awareness and presence and sends its own cursor', () => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const peer = new Awareness(new Y.Doc());
  const cursors = createOfficeCursors();
  const seen: unknown[] = [];
  cursors.subscribe((peers) => seen.push(peers.map((p) => p.name)));
  cursors.attach(awareness);
  cursors.set({ shapeId: 'sp1', slideId: 's2' });
  expect(awareness.getLocalState()?.cursor).toEqual({
    shapeId: 'sp1',
    slideId: 's2',
  });
  awareness.setLocalStateField('cursor', null);
  // A peer's state arrives, then the presence names it.
  peer.setLocalStateField('cursor', { slideId: 's1' });
  applyAwarenessUpdate(
    awareness,
    encodeAwarenessUpdate(peer, [peer.clientID]),
    'remote'
  );
  cursors.names([
    { avatar: null, clients: [peer.clientID], name: 'Bea', person: 1 },
  ]);
  expect(seen.at(-2)).toEqual([]);
  expect(seen.at(-1)).toEqual(['Bea']);
  cursors.attach(null);
  expect(seen.at(-1)).toEqual([]);
});
