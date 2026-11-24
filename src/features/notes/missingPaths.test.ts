/* Plate looks a missing path up by catching slate's throw, whose message is the
   whole document stringified: about 70 ms on a near-limit note, paid on the
   bind and on edits at a block's or the note's end. The @platejs/slate patch
   checks the path instead (pnpm-workspace.yaml). */
import type { TElement, Value } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { afterEach, expect, it, vi } from 'vitest';
import { buildPlugins } from './plugins';

afterEach(() => {
  vi.restoreAllMocks();
});

const VALUE: Value = [
  { children: [{ text: 'Title' }], id: 'a', type: 'h1' },
  {
    children: [{ text: 'Item' }],
    id: 'b',
    indent: 1,
    listStyleType: 'disc',
    type: 'p',
  },
  // Ends in a link with no leaf after it: normalizing adds the empty leaf, as
  // the bind does.
  {
    children: [
      { text: 'See ' },
      { children: [{ text: 'here' }], type: 'a', url: 'https://a.b' },
    ],
    id: 'c',
    type: 'p',
  },
];

it('looks missing paths up without stringifying the document', () => {
  const editor = createPlateEditor({
    nodeId: false,
    plugins: buildPlugins({
      allowExternalAssets: false,
      currentUserId: null,
      discussions: [],
      onSave: () => {},
      workspaceId: 'w',
    }),
    value: structuredClone(VALUE),
  });
  const stringify = vi.spyOn(JSON, 'stringify');

  editor.tf.normalize({ force: true });
  expect((editor.children[2] as TElement).children).toHaveLength(3);
  // Enter, typing and Backspace at the note's end.
  editor.tf.select(editor.api.end([]));
  editor.tf.insertBreak();
  editor.tf.insertText('new');
  editor.tf.deleteBackward('character');
  // Arrows and a mark at a block's end, then a block change and removal.
  editor.tf.select(editor.api.end([0]));
  editor.tf.move({ reverse: true });
  editor.tf.move();
  editor.tf.select({
    anchor: editor.api.start([0])!,
    focus: editor.api.end([0])!,
  });
  editor.tf.toggleMark('bold');
  editor.tf.select(editor.api.end([1]));
  editor.tf.toggleBlock('h2');
  editor.tf.removeNodes({ at: [editor.children.length - 1] });

  expect(editor.api.node([99])).toBeUndefined();
  expect(stringify.mock.calls.some(([value]) => value === editor)).toBe(false);
});
