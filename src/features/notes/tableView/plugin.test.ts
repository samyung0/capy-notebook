import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import { customBlockPlugins } from '../blocks/plugins';
import { newTableViewBlock } from './model';

const block = () =>
  newTableViewBlock({
    done: 'Done',
    kanban: 'Kanban',
    name: 'Name',
    notYet: 'Not yet',
    revising: 'Revising',
    status: 'Status',
    table: 'Table',
  });

describe('the table view plugin', () => {
  it('is a void block lifted to the top level', () => {
    const node = {
      block: block(),
      children: [{ text: '' }],
      id: 'tv_1',
      type: 'table_view',
    };
    const editor = createPlateEditor({
      plugins: customBlockPlugins,
      value: [{ children: [node], type: 'callout' }],
    });
    expect(editor.api.isVoid(node)).toBe(true);
    editor.tf.normalize({ force: true });
    expect(editor.children.map(({ type }) => type)).toContain('table_view');
    expect(
      editor.children.find(({ type }) => type === 'table_view')
    ).toMatchObject({ id: 'tv_1' });
  });
});
