import { createPlateEditor } from 'platejs/react';
import { describe, expect, it, vi } from 'vitest';
import {
  holdInsertPlace,
  insertEditorNode,
  type NoteEditorInstance,
} from './insertEditorNode';

function createEditor(currentText: string, inline = false) {
  const currentBlock = { children: [{ text: currentText }], type: 'p' };
  const editor = {
    api: {
      isInline: vi.fn(() => inline),
      node: vi.fn(() => [currentBlock, [0]]),
    },
    getType: vi.fn((key: string) => key),
    selection: { anchor: { offset: 0, path: [0, 0] } },
    tf: {
      focus: vi.fn(),
      insertNodes: vi.fn(),
      removeNodes: vi.fn(),
      withoutNormalizing: vi.fn((callback: () => void) => callback()),
    },
  } as unknown as NoteEditorInstance;

  return { editor, tf: editor.tf };
}

describe('insertEditorNode', () => {
  it('inserts inline nodes at the current caret without replacing the paragraph', () => {
    const { editor, tf } = createEditor('', true);
    const node = { children: [{ text: '' }], type: 'mention_input' };

    insertEditorNode(editor, node);

    expect(tf.removeNodes).not.toHaveBeenCalled();
    expect(tf.insertNodes).toHaveBeenCalledWith(node, { select: true });
  });

  it('replaces an empty paragraph with a block at the same position', () => {
    const { editor, tf } = createEditor('');
    const node = { children: [{ text: '' }], type: 'toc' };

    insertEditorNode(editor, node);

    expect(tf.removeNodes).toHaveBeenCalledWith({ at: [0] });
    expect(tf.insertNodes).toHaveBeenCalledWith(node, {
      at: [0],
      select: true,
    });
  });

  it('preserves a non-empty paragraph when inserting a block', () => {
    const { editor, tf } = createEditor('Keep this text');
    const node = { children: [{ text: '' }], type: 'toc' };

    insertEditorNode(editor, node);

    expect(tf.removeNodes).not.toHaveBeenCalled();
    expect(tf.insertNodes).toHaveBeenCalledWith(node, { select: true });
  });
});

describe('holdInsertPlace', () => {
  const block = { children: [{ text: '' }], id: 'quiz', type: 'material_ref' };
  // The slash command ran on the empty line [1].
  function commandRan() {
    const editor = createPlateEditor({
      value: [
        { children: [{ text: 'one' }], type: 'p' },
        { children: [{ text: '' }], type: 'p' },
        { children: [{ text: 'three' }], type: 'p' },
      ],
    });
    editor.tf.select({ offset: 0, path: [1, 0] });
    return { editor, place: holdInsertPlace(editor) };
  }
  const texts = (editor: NoteEditorInstance) =>
    editor.children.map((node: { id?: string; children: unknown[] }) =>
      node.id === 'quiz' ? 'QUIZ' : (node.children[0] as { text: string }).text
    );

  it('takes the command line and the caret when the caret stayed', () => {
    const { editor, place } = commandRan();
    place.insert(block);
    expect(texts(editor)).toEqual(['one', 'QUIZ', 'three']);
    expect(editor.selection?.anchor.path).toEqual([1, 0]);
  });

  it('leaves the caret where the user went meanwhile', () => {
    const { editor, place } = commandRan();
    editor.tf.select(editor.api.end([2]));
    editor.tf.insertBreak();
    editor.tf.insertText('typed');
    place.insert(block);
    expect(texts(editor)).toEqual(['one', 'QUIZ', 'three', 'typed']);
    expect(editor.selection?.anchor).toEqual({ offset: 5, path: [3, 0] });
  });

  // The toolbar's Import inserts a whole document this way.
  it('puts several blocks there in order', () => {
    const { editor, place } = commandRan();
    const imported = ['a', 'b'].map((text) => ({
      children: [{ text }],
      type: 'p',
    }));
    editor.tf.select(editor.api.end([2]));
    editor.tf.insertText(' typed');
    place.insert(imported);
    expect(texts(editor)).toEqual(['one', 'a', 'b', 'three typed']);
    expect(editor.selection?.anchor).toEqual({ offset: 11, path: [3, 0] });
  });

  it('goes after the command line once the user typed on it', () => {
    const { editor, place } = commandRan();
    editor.tf.insertText('typed');
    place.insert(block);
    expect(texts(editor)).toEqual(['one', 'typed', 'QUIZ', 'three']);
    expect(editor.selection?.anchor).toEqual({ offset: 5, path: [1, 0] });
  });
});
