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

// The browser's editor writes rooms through Plate, whose NodeIdPlugin marks
// nodes inserted with an id; the store refuses any field an interactive block
// does not define, so that marker once rejected every note it reached.
it('stores an interactive block the note editor inserted', async () => {
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
  YjsEditor.flushLocalChanges(editor as never);

  const stored = new Y.Doc();
  Y.applyUpdate(stored, Y.encodeStateAsUpdate(room));
  const value = yTextToSlateElement(stored.get('content', Y.XmlText))
    .children as unknown[];
  expect(value).toHaveLength(2);
  expect(() => assertCanonicalMaterialValue(value, 'note')).not.toThrow();
});
