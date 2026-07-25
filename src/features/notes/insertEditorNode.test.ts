import { describe, expect, it, vi } from 'vitest';
import { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';

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
