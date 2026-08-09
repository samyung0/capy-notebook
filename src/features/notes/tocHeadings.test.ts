import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { queryHeadings } from './tocHeadings';

function editorWithHeadings() {
  return createPlateEditor({
    value: [
      { children: [{ text: 'Intro' }], id: 'h_intro', type: 'h1' },
      { children: [{ text: 'Body copy' }], id: 'p_body', type: 'p' },
      {
        children: [
          { children: [{ text: 'Nested' }], id: 'h_nested', type: 'h2' },
        ],
        id: 'quote',
        type: 'blockquote',
      },
    ],
  });
}

describe('queryHeadings', () => {
  it('reports headings with absolute paths, including nested ones', () => {
    const headings = queryHeadings(editorWithHeadings());

    expect(headings).toEqual([
      { depth: 1, id: 'h_intro', path: [0], title: 'Intro', type: 'h1' },
      { depth: 2, id: 'h_nested', path: [2, 0], title: 'Nested', type: 'h2' },
    ]);
  });

  it('skips headings with no text, matching the upstream query', () => {
    const editor = createPlateEditor({
      value: [{ children: [{ text: '' }], id: 'h_empty', type: 'h1' }],
    });

    expect(queryHeadings(editor)).toEqual([]);
  });

  // The reason this module exists: the TOC subscribes through a selector with
  // reference equality, so an unchanged document must yield the same array.
  it('returns the same array when an unrelated block changes', () => {
    const editor = editorWithHeadings();
    const before = queryHeadings(editor);

    editor.tf.insertText(' extended', { at: { offset: 9, path: [1, 0] } });

    expect(queryHeadings(editor)).toBe(before);
  });

  it('returns a new list when a heading title changes', () => {
    const editor = editorWithHeadings();
    const before = queryHeadings(editor);

    editor.tf.insertText('!', { at: { offset: 5, path: [0, 0] } });
    const after = queryHeadings(editor);

    expect(after).not.toBe(before);
    expect(after[0].title).toBe('Intro!');
  });

  // Cached headings are stored per block and keyed on node identity. Inserting
  // a block shifts later paths without changing any of those identities, so a
  // cache that stored absolute paths would report stale ones here.
  it('recomputes paths when a block is inserted before a heading', () => {
    const editor = editorWithHeadings();
    queryHeadings(editor);

    editor.tf.insertNodes(
      { children: [{ text: 'Added' }], id: 'p_added', type: 'p' } as never,
      { at: [0] }
    );

    expect(queryHeadings(editor).map((heading) => heading.path)).toEqual([
      [1],
      [3, 0],
    ]);
  });

  it('drops a heading that was removed', () => {
    const editor = editorWithHeadings();
    queryHeadings(editor);

    editor.tf.removeNodes({ at: [0] });

    expect(queryHeadings(editor).map((heading) => heading.id)).toEqual([
      'h_nested',
    ]);
  });
});
