import { EditorState } from '@codemirror/state';
import { expect, it } from 'vitest';
import { byteBound } from './MermaidCodeEditor';

// The note Mermaid dialog's 64 KB bound, at 12 bytes: 'é' is two.
it('refuses user edits that grow the source past its byte bound', () => {
  let refused = 0;
  const start = EditorState.create({
    doc: 'ééééé',
    extensions: byteBound(12, () => refused++),
  });
  const edit = (
    state: EditorState,
    changes: { from: number; to?: number; insert?: string },
    userEvent?: string
  ) => state.update({ changes, userEvent }).state.doc.toString();

  expect(edit(start, { from: 5, insert: 'ab' }, 'input.type')).toBe('éééééab');
  expect(edit(start, { from: 5, insert: 'éa' }, 'input.paste')).toBe('ééééé');
  expect(edit(start, { from: 0, insert: 'éé' }, 'undo')).toBe('ééééé');
  expect(refused).toBe(2);

  // Another peer's edit carries no user event and always lands.
  const over = start.update({ changes: { from: 0, insert: 'éé' } }).state;
  expect(over.doc.toString()).toBe('ééééééé');
  // Past the bound, shrinking or keeping the size still lands, growing not.
  expect(edit(over, { from: 0, to: 1 }, 'delete.backward')).toBe('éééééé');
  expect(edit(over, { from: 0, insert: 'ab', to: 1 }, 'input.type')).toBe(
    'abéééééé'
  );
  expect(edit(over, { from: 0, insert: 'a' }, 'input.type')).toBe('ééééééé');
  expect(refused).toBe(3);
});
