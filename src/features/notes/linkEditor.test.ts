import { LinkPlugin } from '@platejs/link/react';
import { KEYS } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { cloneLinkSelection, upsertLinkAtSelection } from './linkEditor';

describe('upsertLinkAtSelection', () => {
  it('restores the captured range before linking selected text', () => {
    const editor = createPlateEditor({
      plugins: [LinkPlugin],
      value: [{ children: [{ text: 'Selected text' }], type: KEYS.p }],
    });
    editor.tf.select({
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 8, path: [0, 0] },
    });
    const selection = cloneLinkSelection(editor.selection);

    editor.tf.select({ offset: 13, path: [0, 0] });
    const applied = upsertLinkAtSelection(editor, selection, {
      text: 'Selected',
      url: 'https://example.com',
    });

    expect(applied).toBe(true);
    const children = (
      editor.children[0] as { children: Array<Record<string, unknown>> }
    ).children;
    expect(children.find((child) => child.type === KEYS.link)).toMatchObject({
      children: [{ text: 'Selected' }],
      type: KEYS.link,
      url: 'https://example.com',
    });
    expect(children).toContainEqual({ text: ' text' });
  });
});
