import { afterEach, expect, it } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { createOfficeCursors, officePeers } from './officeCursors';

afterEach(() => useNoteEditorPrefs.getState().setShowOthers(true));

const cell = { anchor: { col: 1, row: 2 }, head: { col: 1, row: 2 } };

/** Security regression (Epo 2026-10-20, 2026-10-28): an Office cursor is
 * labelled with the verified name the room's presence gives its client id,
 * never the name a peer puts in its own awareness; an id the presence does
 * not list (a reader), a malformed cursor and a state holding anything beside
 * its cursor (the room's field list) are not drawn. Fails if a label is read
 * from awareness. */
it('labels a cursor from the presence, never from awareness', () => {
  const states = new Map<number, unknown>([
    [1, { cursor: { ...cell, sheet: 'S1' } }],
    [2, { cursor: { ...cell, sheet: 'S1' }, user: { name: 'Mallory' } }],
    [3, { cursor: { sheet: 'S1' } }],
    [4, { cursor: { ...cell, sheet: 'S1' } }],
    [5, { cursor: { name: 'Mallory', slideId: 's1' } }],
    [9, { cursor: { slideId: 's1' } }],
  ]);
  const names = new Map([
    [1, 'Peer'],
    [2, 'Rae'],
    [3, 'Cal'],
    [5, 'Sam'],
    [9, 'Me'],
  ]);
  expect(officePeers(states, 9, names)).toEqual([
    { clientId: 1, cursor: { ...cell, sheet: 'S1' }, name: 'Peer' },
  ]);
});

/** Epo 2026-10-28: DOCX positions go to the room as base64 and come back to
 * the frame as the byte arrays it sent. */
it('carries DOCX positions as base64 in awareness', () => {
  const awareness = new Awareness(new Y.Doc());
  const cursors = createOfficeCursors();
  cursors.attach(awareness);
  const docx = { anchor: [1, 2, 250], head: [1, 2, 251], story: 'body' };
  cursors.set(docx);
  expect(awareness.getLocalState()?.cursor).toEqual({
    anchor: 'AQL6',
    head: 'AQL7',
    story: 'body',
  });
  const names = new Map([[7, 'Bea']]);
  const states = new Map([[7, awareness.getLocalState()]]);
  expect(officePeers(states, 9, names)).toEqual([
    { clientId: 7, cursor: docx, name: 'Bea' },
  ]);
  // A number array in awareness is not the room's shape.
  expect(officePeers(new Map([[7, { cursor: docx }]]), 9, names)).toEqual([]);
});

it('follows the room’s awareness, presence and show-others switch, and sends its own cursor', () => {
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
  // This device's switch hides co-editors' cursors, and shows them again.
  useNoteEditorPrefs.getState().setShowOthers(false);
  expect(seen.at(-1)).toEqual([]);
  useNoteEditorPrefs.getState().setShowOthers(true);
  expect(seen.at(-1)).toEqual(['Bea']);
  cursors.attach(null);
  expect(seen.at(-1)).toEqual([]);
});
