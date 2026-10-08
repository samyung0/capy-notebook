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

// The browser's editor writes rooms through Plate, whose NodeIdPlugin repairs
// inserted nodes (its `_id` marker, ids already in the note) on its own copy
// of the operation only; the store refuses what reaches the room unrepaired.
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
  // Plate turns NodeIdPlugin off under tests; the editor has it on.
  const editor = createSlateEditor({
    nodeId: {},
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

it('stores an interactive block the note editor inserted', async () => {
  const { editor, stored } = await noteRoom();
  editor.tf.select(editor.api.end([0]));
  // The toolbar's Import inserts the imported document this way.
  editor.tf.insertNodes([
    {
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

it('stores a duplicated block and a split of its source', async () => {
  const { editor, stored } = await noteRoom();
  // The block menu's Duplicate (blockSelection.duplicate) inserts the same
  // nodes, ids included.
  editor.tf.duplicateNodes({ nodes: [[editor.children[0], [0]]] });
  // The copy has a fresh id, the same in the editor and the room.
  const ids = stored().map((node) => (node as { id: string }).id);
  expect(new Set(ids).size).toBe(2);
  expect(ids).toEqual(editor.children.map((node) => node.id));
  // Plate left its marker on the source; Enter there splits it.
  editor.tf.select(editor.api.end([0]));
  editor.tf.insertBreak();
  const value = stored();
  expect(value).toHaveLength(3);
  expect(() => assertCanonicalMaterialValue(value, 'note')).not.toThrow();
  expect(JSON.stringify(value)).not.toContain('_id');
});
