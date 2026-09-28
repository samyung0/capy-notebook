import { KEYS, NodeApi } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { mermaidNode } from '@/features/materials/document';
import { useNoteEditorPrefs } from '../noteEditorPrefs';
import { setMermaidCaption } from './mermaidBlock';
import { MermaidCaptionPlugin, MermaidElementPlugin } from './plugins';

function createEditor(caption = 'Old caption') {
  return createPlateEditor({
    plugins: [MermaidElementPlugin, MermaidCaptionPlugin],
    value: [
      { children: [{ text: 'Intro' }], type: KEYS.p },
      mermaidNode('flowchart LR\n  A --> B', caption),
    ],
  });
}

describe('mermaid block', () => {
  it('moves a selection on the caption element onto its text', () => {
    const editor = createEditor();

    // What slate-react reports for a DOM selection inside the void.
    editor.tf.select({ offset: 0, path: [1, 0] });

    expect(editor.selection).toEqual({
      anchor: { offset: 0, path: [1, 0, 0] },
      focus: { offset: 0, path: [1, 0, 0] },
    });
    expect(() => editor.api.marks()).not.toThrow();
  });

  it('replaces the caption text inside the void', () => {
    const editor = createEditor();

    setMermaidCaption(editor, [1], 'New caption');
    expect(NodeApi.string(editor.children[1])).toBe('New caption');

    setMermaidCaption(editor, [1], '');
    expect(editor.children[1]).toMatchObject({
      children: [{ children: [{ text: '' }], type: 'mermaid_caption' }],
    });
  });

  it("stamps the creator's default theme on inserted blocks only", () => {
    useNoteEditorPrefs.getState().setMermaidTheme('handDrawn');
    const editor = createEditor();

    editor.tf.insertNodes(mermaidNode('flowchart LR\n  C --> D'), { at: [2] });
    editor.tf.insertNodes(
      { ...mermaidNode('flowchart LR\n  E --> F'), theme: 'kawaii' },
      { at: [3] }
    );

    expect(editor.children[1]).not.toHaveProperty('theme');
    expect(editor.children[2]).toMatchObject({ theme: 'handDrawn' });
    expect(editor.children[3]).toMatchObject({ theme: 'kawaii' });
  });
});
