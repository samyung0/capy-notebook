import { createSlatePlugin } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { VoidBlockPastePlugin } from './pastePlugins';

const quiz = (id: string) => ({
  children: [{ text: '' }],
  id,
  materialId: `mat_${id}`,
  refKind: 'quiz',
  type: 'material_ref',
});

describe('VoidBlockPastePlugin', () => {
  // The caret on a quiz block (a void): Slate alone drops the fragment.
  function onQuizBlock() {
    const editor = createPlateEditor({
      plugins: [
        createSlatePlugin({
          key: 'material_ref',
          node: { isElement: true, isVoid: true },
        }),
        VoidBlockPastePlugin,
      ],
      value: [
        { children: [{ text: 'before' }], id: 'before', type: 'p' },
        quiz('held'),
        { children: [{ text: 'after' }], id: 'after', type: 'p' },
      ] as never,
    });
    editor.tf.select({ offset: 0, path: [1, 0] });
    return editor;
  }
  const ids = (editor: ReturnType<typeof onQuizBlock>) =>
    (editor.children as { id?: string }[]).map((node) => node.id);

  it('puts pasted blocks right after the block, the caret following them', () => {
    const editor = onQuizBlock();
    editor.tf.insertFragment([
      quiz('pasted'),
      { children: [{ text: 'pasted line' }], id: 'line', type: 'p' },
    ] as never);
    expect(ids(editor)).toEqual(['before', 'held', 'pasted', 'line', 'after']);
    expect(editor.selection?.anchor).toEqual({ offset: 11, path: [3, 0] });
  });

  it('leaves a paste of text to the default handling', () => {
    const editor = onQuizBlock();
    editor.tf.insertFragment([{ text: 'loose text' }] as never);
    expect(ids(editor)).toEqual(['before', 'held', 'after']);
  });
});
