import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  slatePointToRelativePosition,
  YjsEditor,
} from '@slate-yjs/core';
import type { Point } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { afterEach, expect, it } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { InlineEquationPlugin } from './equationPlugins';
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
  /** The peer's selection, relayed as the server does (JSON). */
  const select = (anchor: Point, focus = anchor) => {
    const relative = (point: Point) =>
      slatePointToRelativePosition(
        (editor as unknown as YjsEditor).sharedRoot,
        editor as never,
        point
      );
    peer.setLocalState(
      JSON.parse(
        JSON.stringify({
          data: { color: '#123456', name: 'Mallory' },
          selection: { anchor: relative(anchor), focus: relative(focus) },
        })
      )
    );
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(peer, [peer.clientID]),
      'server'
    );
  };
  /** The verified names the room's presence gives client ids. */
  const names = new Map([[peer.clientID, 'Peer']]);
  /** What `decorate` returns for the root entry. */
  const drawn = (peers = readRemotePeers(editor, names)) =>
    remoteCursorRangesForEntry(editor, [editor, []], peers);
  return { drawn, editor, names, peer, select };
}

it('marks a peer caret, not only a peer selection, once', () => {
  const { drawn, editor, select } = room();
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
  const peers = readRemotePeers(editor, new Map());
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
  const { drawn, editor, select } = room();
  select({ offset: 5, path: [0, 2] });
  // The peer stays put: its state is the same object throughout.
  const peers = readRemotePeers(editor, new Map());
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

/** Security regression (Epo 2026-10-20): a cursor's label is the verified
 * name the room's presence gives its client id, never the name the peer's
 * awareness claims ('Mallory' here); a client the presence does not name
 * gets the generic label. Fails if labels read the awareness name. */
it('labels a peer caret with its verified name, never its claimed one', () => {
  const { drawn, editor, names, peer, select } = room();
  select({ offset: 2, path: [0, 0] });
  expect(drawn()).toEqual([
    expect.objectContaining({ remoteCursorName: 'Peer' }),
  ]);
  names.delete(peer.clientID);
  const [unnamed] = readRemotePeers(editor, names);
  expect(unnamed?.name).toBeUndefined();
  expect(JSON.stringify(drawn(readRemotePeers(editor, names)))).not.toContain(
    'Mallory'
  );
});
