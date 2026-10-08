import {
  slateNodesToInsertDelta,
  withYjs,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { type AnySlatePlugin, createSlateEditor } from 'platejs';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { assertCanonicalMaterialValue } from './materialDocument.js';

// Outside this package's tsconfig root, so loaded by path (see limits.test.ts).
const STABLE_IDS = '@/features/notes/stableElementIds.ts';

// The browser's note editor writes rooms through Plate with its own id plugin
// in place of Plate's NodeIdPlugin (`nodeId: false`); the store refuses a room
// whose ids repeat or whose interactive blocks carry extra fields.
async function noteRoom() {
  const { stableElementIdsPlugin } = (await import(STABLE_IDS)) as {
    stableElementIdsPlugin: AnySlatePlugin;
  };
  const room = new Y.Doc();
  const root = room.get('content', Y.XmlText);
  root.applyDelta(
    slateNodesToInsertDelta([
      { children: [{ text: 'line' }], id: 'line', type: 'p' },
    ] as never)
  );
  const editor = createSlateEditor({
    nodeId: false,
    plugins: [stableElementIdsPlugin],
  });
  // Slate-Yjs extends the editor in place.
  withYjs(editor as never, root);
  YjsEditor.connect(editor as never);
  /** The room's value as the store reads it. */
  const stored = () => {
    YjsEditor.flushLocalChanges(editor as never);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(room));
    return yTextToSlateElement(copy.get('content', Y.XmlText))
      .children as unknown[];
  };
  return { editor, stored };
}

it("stores an interactive block that arrives with Plate's insert marker", async () => {
  const { editor, stored } = await noteRoom();
  editor.tf.select(editor.api.end([0]));
  // Copied from a document that holds the marker; the toolbar's Import
  // inserts the same way.
  editor.tf.insertNodes([
    {
      _id: 'embed',
      caption: 'Embed',
      children: [{ text: '' }],
      html: '<p>hi</p>',
      id: 'embed',
      type: 'html_embed',
    },
  ]);
  const value = stored();
  expect(value).toHaveLength(2);
  expect(() => assertCanonicalMaterialValue(value, 'note')).not.toThrow();
});

it('keeps the editor and the room on the same ids through Enter, Duplicate and a split', async () => {
  const { editor, stored } = await noteRoom();
  // Enter at the end of a line, then a split inside it.
  editor.tf.select(editor.api.end([0]));
  editor.tf.insertBreak();
  editor.tf.insertText('second');
  editor.tf.select({ offset: 2, path: [0, 0] });
  editor.tf.insertBreak();
  // The block menu's Duplicate (blockSelection.duplicate) inserts the same
  // nodes, ids included.
  editor.tf.duplicateNodes({ nodes: [[editor.children[0], [0]]] });
  const value = stored();
  const ids = value.map((node) => (node as { id: string }).id);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
  expect(ids).toEqual(editor.children.map((node) => node.id));
  expect(() => assertCanonicalMaterialValue(value, 'note')).not.toThrow();
});
