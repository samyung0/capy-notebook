import { EditorState } from '@codemirror/state';
import { expect, it } from 'vitest';
import { lengthBound } from './MermaidCodeEditor';

// The Mermaid source cap (MERMAID_SOURCE_MAX, UTF-16 units) at 6: an astral
// character is two.
it('refuses user edits that grow the source past its length bound', () => {
  let refused = 0;
  const start = EditorState.create({
    doc: 'ab😀',
    extensions: lengthBound(6, () => refused++),
  });
  const edit = (
    state: EditorState,
    changes: { from: number; to?: number; insert?: string },
    userEvent?: string
  ) => state.update({ changes, userEvent }).state.doc.toString();

  expect(edit(start, { from: 4, insert: 'cd' }, 'input.type')).toBe('ab😀cd');
  expect(edit(start, { from: 4, insert: '😀a' }, 'input.paste')).toBe('ab😀');
  expect(edit(start, { from: 0, insert: 'x😀' }, 'undo')).toBe('ab😀');
  expect(refused).toBe(2);

  // Another peer's edit carries no user event and always lands.
  const over = start.update({ changes: { from: 0, insert: 'xyz' } }).state;
  expect(over.doc.toString()).toBe('xyzab😀');
  // Past the bound, shrinking or keeping the size still lands, growing not.
  expect(edit(over, { from: 0, to: 1 }, 'delete.backward')).toBe('yzab😀');
  expect(edit(over, { from: 0, insert: 'q', to: 1 }, 'input.type')).toBe(
    'qyzab😀'
  );
  expect(edit(over, { from: 0, insert: 'q' }, 'input.type')).toBe('xyzab😀');
  expect(refused).toBe(3);
});
