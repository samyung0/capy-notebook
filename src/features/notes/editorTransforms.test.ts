import { codeBlockToDecorations } from '@platejs/code-block';
import { CodeBlockPlugin } from '@platejs/code-block/react';
import { common, createLowlight } from 'lowlight';
import { KEYS } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { clearEditorFormatting, toggleEditorBlock } from './editorTransforms';

function createCodeEditor(text = 'console.log()') {
  const lowlight = createLowlight(common);
  const editor = createPlateEditor({
    plugins: [CodeBlockPlugin.configure({ options: { lowlight } })],
    value: [{ children: [{ text }], type: KEYS.p }],
  });
  editor.tf.select({ offset: text.length, path: [0, 0] });
  toggleEditorBlock(editor, KEYS.codeBlock);
  return editor;
}

describe('toggleEditorBlock', () => {
  it('creates the nested code-line shape required by Enter', () => {
    const editor = createCodeEditor();

    editor.tf.insertBreak();

    expect(editor.children).toHaveLength(1);
    expect(editor.children[0]).toMatchObject({
      children: [
        { children: [{ text: 'console.log()' }], type: KEYS.codeLine },
        { children: [{ text: '' }], type: KEYS.codeLine },
      ],
      type: KEYS.codeBlock,
    });
  });

  it('keeps multiline plain-text paste inside the current code block', () => {
    const editor = createCodeEditor('');
    const data = {
      getData: (type: string) => (type === 'text/plain' ? 'first\nsecond' : ''),
    } as DataTransfer;

    editor.tf.insertData(data);

    expect(editor.children).toHaveLength(1);
    expect(editor.children[0]).toMatchObject({
      children: [
        { children: [{ text: 'first' }], type: KEYS.codeLine },
        { children: [{ text: 'second' }], type: KEYS.codeLine },
      ],
      type: KEYS.codeBlock,
    });
  });

  it('produces JavaScript decorations for console.log', () => {
    const editor = createCodeEditor();
    editor.tf.setNodes({ lang: 'javascript' }, { at: [0] });
    const codeBlock = editor.children[0];
    const decorations = codeBlockToDecorations(editor, [codeBlock, [0]]);
    const classNames = [...decorations.values()]
      .flat()
      .map((item) => (item as { className?: string }).className);

    expect(classNames).toContain('hljs-variable language_');
    expect(classNames).toContain('hljs-title function_');
  });
});

describe('clearEditorFormatting', () => {
  it('strips every mark from an expanded selection', () => {
    // Regression: editor.tf.removeMarks() without keys only clears pending
    // caret marks, so the toolbar's "Clear formatting" did nothing.
    const editor = createPlateEditor({
      value: [
        {
          children: [
            { bold: true, text: 'bold' },
            { italic: true, text: ' and ', underline: true },
            { color: '#ff0000', highlight: true, text: 'colored' },
          ],
          type: KEYS.p,
        },
      ],
    });
    editor.tf.select({
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 'colored'.length, path: [0, 2] },
    });

    clearEditorFormatting(editor);

    const leaves = (
      editor.children[0] as { children: Record<string, unknown>[] }
    ).children;
    for (const leaf of leaves) {
      expect(Object.keys(leaf)).toEqual(['text']);
    }
    expect(leaves.map((leaf) => leaf.text).join('')).toBe('bold and colored');
  });

  it('keeps marks outside the selection', () => {
    const editor = createPlateEditor({
      value: [
        {
          children: [
            { bold: true, text: 'keep' },
            { bold: true, text: ' drop' },
          ],
          type: KEYS.p,
        },
      ],
    });
    editor.tf.select({
      anchor: { offset: 'keep'.length, path: [0, 0] },
      focus: { offset: ' drop'.length, path: [0, 1] },
    });

    clearEditorFormatting(editor);

    const leaves = (
      editor.children[0] as { children: Record<string, unknown>[] }
    ).children;
    expect(leaves[0]).toEqual({ bold: true, text: 'keep' });
    expect(leaves[1]).toEqual({ text: ' drop' });
  });
});
