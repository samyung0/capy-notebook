import { BaseYjsPlugin } from '@platejs/yjs';
import { slateNodesToInsertDelta, YjsEditor } from '@slate-yjs/core';
import type { Point } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { afterEach, expect, it } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type PresenceConnection,
  presenceClients,
} from '@/features/collaboration/presence';
import { InlineEquationPlugin } from './equationPlugins';
import { sendCaret } from './notePresence';
import { readRemotePeers, remoteCursorRangesForEntry } from './RemoteCursors';

const equation = {
  children: [{ text: '' }],
  texExpression: 'T',
  type: 'inline_equation',
};
const value = [
  {
    children: [
      { text: 'Let ' },
      equation,
      { text: ' be bounded ' },
      equation,
      { text: '' },
    ],
    id: 'p1',
    type: 'p',
  },
  {
    children: [{ text: '' }, equation, { text: ' opens this line' }],
    id: 'p2',
    type: 'p',
  },
];

const BASE64 = /^[A-Za-z0-9+/=]{1,64}$/;

const opened: (() => void)[] = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
});

/** This tab's editor on a room holding `value`, and a peer's presence in it. */
function room() {
  const doc = new Y.Doc();
  doc
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
  const awareness = new Awareness(doc);
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      InlineEquationPlugin,
      BaseYjsPlugin.configure({
        options: { awareness, cursors: {}, ydoc: doc },
      }),
    ],
  } as never);
  YjsEditor.connect(editor as never);
  // Normalizing adds the empty texts beside inline elements, which Yjs does
  // not hold; the editor flushes such edits on change, before it renders.
  YjsEditor.flushLocalChanges(editor as never);
  opened.push(() => YjsEditor.disconnect(editor as never));
  const peer = new Awareness(new Y.Doc());
  /** The peer's state, relayed as the server does. */
  const relay = () =>
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(peer, [peer.clientID]),
      'server'
    );
  /** The peer's selection, as its editor sends it. */
  const select = (anchor: Point, focus = anchor) => {
    sendCaret(editor as never, peer, { anchor, focus });
    relay();
  };
  /** The room's presence: the peer's verified name and person. */
  const connection: PresenceConnection = {
    avatar: null,
    clients: [peer.clientID],
    name: 'Peer',
    person: 11,
  };
  const clients = presenceClients([connection]);
  /** What `decorate` returns for the root entry. */
  const drawn = (peers = readRemotePeers(editor, clients)) =>
    remoteCursorRangesForEntry(editor, [editor, []], peers);
  return { clients, connection, drawn, editor, peer, relay, select };
}

it('marks a peer caret, not only a peer selection, once', () => {
  const { clients, drawn, editor, select } = room();
  select({ offset: 2, path: [0, 0] });
  expect(drawn()).toEqual([
    expect.objectContaining({
      anchor: { offset: 2, path: [0, 0] },
      focus: { offset: 2, path: [0, 0] },
      remoteCursorCaret: true,
      remoteCursorName: 'Peer',
    }),
  ]);
  // Only the root returns it: slate-react hands it down to the text, so a
  // block or text entry returning it too would draw it again.
  const peers = readRemotePeers(editor, clients);
  expect(
    remoteCursorRangesForEntry(editor, [editor.children[0], [0]], peers)
  ).toEqual([]);
  expect(
    remoteCursorRangesForEntry(editor, [{ text: 'Let ' }, [0, 0]], peers)
  ).toEqual([]);

  select({ offset: 0, path: [0, 0] }, { offset: 3, path: [0, 0] });
  const [range, caret, ...rest] = drawn();
  expect(rest).toEqual([]);
  expect(range).toMatchObject({
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 3, path: [0, 0] },
  });
  expect(range).not.toHaveProperty('remoteCursorCaret');
  expect(caret).toMatchObject({
    anchor: { offset: 3, path: [0, 0] },
    focus: { offset: 3, path: [0, 0] },
    remoteCursorCaret: true,
  });
});

it('places a peer caret beside or on an inline equation', () => {
  const { drawn, select } = room();
  const caretAt = (point: Point) => {
    select(point);
    return drawn().map(({ focus }) => focus);
  };
  // The empty texts Slate keeps around inline elements (patched slate-yjs).
  expect(caretAt({ offset: 0, path: [0, 4] })).toEqual([
    { offset: 0, path: [0, 4] },
  ]);
  expect(caretAt({ offset: 0, path: [1, 0] })).toEqual([
    { offset: 0, path: [1, 0] },
  ]);
  // On the equation itself (a void, whose text gets no decorations): drawn
  // right after it.
  expect(caretAt({ offset: 0, path: [0, 1, 0] })).toEqual([
    { offset: 0, path: [0, 2] },
  ]);
});

it('moves an idle peer caret when a local edit lands before it', async () => {
  const { clients, drawn, editor, select } = room();
  select({ offset: 5, path: [0, 2] });
  // The peer stays put: its state is the same object throughout.
  const peers = readRemotePeers(editor, clients);
  const before = drawn(peers);
  expect(before.map(({ focus }) => focus)).toEqual([
    { offset: 5, path: [0, 2] },
  ]);
  // Resolved once per document version, not once per call.
  expect(drawn(peers)).toBe(before);

  editor.tf.insertText('abc', { at: { offset: 0, path: [0, 2] } });
  // slate-yjs flushes the edit to Yjs on change, before React renders.
  await Promise.resolve();
  expect(drawn(peers).map(({ focus }) => focus)).toEqual([
    { offset: 8, path: [0, 2] },
  ]);
});

/** Epo 2026-10-28: a caret goes as `{s}`, a selection as `{s, f}`: no
 * colour, no name, no JSON positions. */
it('sends a caret in the compact shape', () => {
  const { peer, select } = room();
  select({ offset: 2, path: [0, 0] });
  expect(Object.keys(peer.getLocalState() ?? {})).toEqual(['s']);
  select({ offset: 0, path: [0, 0] }, { offset: 3, path: [0, 0] });
  const state = peer.getLocalState() ?? {};
  expect(Object.keys(state).sort()).toEqual(['f', 's']);
  expect(state.s).toMatch(BASE64);
});

/** Security regression (Epo 2026-10-20, 2026-10-28): a cursor's label is the
 * verified name the room's presence gives its client id and its colour the
 * palette's for that person's number, never anything the peer's awareness
 * says: a state claiming a name or a colour is not drawn at all, nor is a
 * client the presence does not list yet. Fails if a caret reads its label
 * or colour from awareness. */
it('labels and colours a peer caret from the presence, never from its awareness', () => {
  const { clients, connection, drawn, editor, peer, relay, select } = room();
  select({ offset: 2, path: [0, 0] });
  expect(drawn()).toEqual([
    expect.objectContaining({
      remoteCursorColor: 3,
      remoteCursorName: 'Peer',
    }),
  ]);
  // A connection without a name gets the generic label.
  const unnamed = presenceClients([{ ...connection, name: null }]);
  expect(readRemotePeers(editor, unnamed)).toEqual([
    expect.objectContaining({ color: 3, name: undefined }),
  ]);
  expect(readRemotePeers(editor, new Map())).toEqual([]);
  peer.setLocalState({
    ...peer.getLocalState(),
    data: { color: 'url(https://example.com/x)', name: 'Mallory' },
  });
  relay();
  expect(readRemotePeers(editor, clients)).toEqual([]);
});
