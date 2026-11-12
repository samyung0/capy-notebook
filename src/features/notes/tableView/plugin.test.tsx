import { createPlateEditor, Plate, PlateContent } from 'platejs/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { customBlockPlugins } from '../blocks/plugins';
import { COLUMN_WIDTH } from './display';
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

  it('draws a read-only note with its view tabs and no edit controls', () => {
    const editor = createPlateEditor({
      plugins: customBlockPlugins,
      value: [
        {
          block: { ...block(), title: 'Revision tracker' },
          children: [{ text: '' }],
          id: 'tv_1',
          type: 'table_view',
        },
      ],
    });
    const html = renderToStaticMarkup(
      <Plate editor={editor} readOnly>
        <PlateContent readOnly />
      </Plate>
    );
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('Revision tracker');
    expect(html).not.toContain('New record');
    expect(html).not.toContain('<input');
    // The read-only table's widths (display.ts), so View and editor match.
    expect(html).toContain(
      `--w-phone:${COLUMN_WIDTH.title[0]}px;--w-wide:${COLUMN_WIDTH.title[1]}px`
    );
  });

  it('draws a block with no view as a table with + to add one (revision 2.3)', () => {
    const editor = createPlateEditor({
      plugins: customBlockPlugins,
      value: [
        {
          block: { ...block(), views: [] },
          children: [{ text: '' }],
          id: 'tv_1',
          type: 'table_view',
        },
      ],
    });
    const html = renderToStaticMarkup(
      <Plate editor={editor}>
        <PlateContent />
      </Plate>
    );
    expect(html).not.toContain('role="tab"');
    expect(html).toContain('aria-label="Add a view"');
    expect(html).toContain('<table');
  });
});
