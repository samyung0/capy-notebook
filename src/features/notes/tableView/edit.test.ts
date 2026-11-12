import { describe, expect, it } from 'vitest';
import {
  addOption,
  addRow,
  addView,
  deleteColumn,
  deleteOption,
  deleteView,
  duplicateColumn,
  insertColumn,
  insertRow,
  kanbanGroups,
  moveCard,
  newColumn,
  nextColor,
  parseNumber,
  retypeColumn,
  setCell,
  setSort,
  uniqueName,
} from './edit';
import {
  drawnColumns,
  isTableViewBlock,
  TABLE_VIEW_LIMITS,
  type TableViewBlock,
} from './model';

function tracker(): TableViewBlock {
  return {
    columns: [
      {
        id: 'c_status',
        kind: 'select',
        name: 'Status',
        options: [
          { color: 'gray', id: 'o_1', name: 'Not yet' },
          { color: 'orange', id: 'o_2', name: 'Revising' },
        ],
      },
      { id: 'c_title', kind: 'title', name: 'Topic' },
      { id: 'c_mark', kind: 'number', name: 'Mark' },
    ],
    rows: [
      { c_mark: 6, c_status: 'o_2', c_title: 'Krebs', id: 'r_1' },
      { c_title: 'Glycolysis', id: 'r_2' },
    ],
    title: 'Revision tracker',
    views: [
      { id: 'v_1', kind: 'table', name: 'Table' },
      { groupBy: 'c_status', id: 'v_2', kind: 'kanban', name: 'Kanban' },
    ],
  };
}

const names = (block: TableViewBlock) =>
  drawnColumns(block).map(({ name }) => name);

describe('table view edits', () => {
  it('set and empty a cell, keeping the other rows', () => {
    const block = tracker();
    const set = setCell(block, 'r_2', 'c_mark', 9);
    expect(set.rows[1].c_mark).toBe(9);
    expect(set.rows[0]).toBe(block.rows[0]);
    const emptied = setCell(set, 'r_2', 'c_mark', undefined);
    expect(emptied.rows[1]).toEqual({ c_title: 'Glycolysis', id: 'r_2' });
    expect(setCell(block, 'r_1', 'c_mark', 6)).toBe(block);
  });

  it('change only the cell key they write, the row’s other keys as they were', () => {
    const block = tracker();
    block.rows[0].c_gone = 'left by a merge';
    const next = setCell(block, 'r_1', 'c_title', 'Krebs cycle');
    expect(next.rows[0]).toEqual({ ...block.rows[0], c_title: 'Krebs cycle' });
  });

  it('write a hostile column id as data, never through the prototype', () => {
    const next = setCell(tracker(), 'r_2', '__proto__', 'x');
    expect(Object.hasOwn(next.rows[1], '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(next.rows[1])).toBe(Object.prototype);
  });

  it('add and insert records', () => {
    const { block, rowId } = addRow(tracker(), { c_status: 'o_1' });
    expect(block.rows.at(-1)).toEqual({ c_status: 'o_1', id: rowId });
    const above = insertRow(block, 'r_2', 'above');
    expect(above.block.rows.map(({ id }) => id)).toEqual([
      'r_1',
      above.rowId,
      'r_2',
      rowId,
    ]);
    expect(isTableViewBlock(above.block)).toBe(true);
  });

  it('insert columns where they are drawn, right of the title first', () => {
    const block = tracker();
    const right = insertColumn(block, newColumn('Notes'), {
      columnId: 'c_title',
      side: 'right',
    });
    expect(names(right)).toEqual(['Topic', 'Notes', 'Status', 'Mark']);
    const left = insertColumn(block, newColumn('Due', 'date'), {
      columnId: 'c_mark',
      side: 'left',
    });
    expect(names(left)).toEqual(['Topic', 'Status', 'Due', 'Mark']);
    expect(names(insertColumn(block, newColumn('End')))).toEqual([
      'Topic',
      'Status',
      'Mark',
      'End',
    ]);
    expect(isTableViewBlock(left)).toBe(true);
  });

  it('duplicate a column with its cells; the title’s copy is text', () => {
    const copy = duplicateColumn(tracker(), 'c_title');
    const added = drawnColumns(copy)[1];
    expect(added).toMatchObject({ kind: 'text', name: 'Topic' });
    expect(copy.rows[0][added.id]).toBe('Krebs');
    expect(isTableViewBlock(copy)).toBe(true);
  });

  it('delete a column with its cells and its sort', () => {
    const sorted = setSort(tracker(), 'v_1', {
      columnId: 'c_mark',
      dir: 'desc',
    });
    const next = deleteColumn(sorted, 'c_mark');
    expect(names(next)).toEqual(['Topic', 'Status']);
    expect(next.rows[0]).not.toHaveProperty('c_mark');
    expect(next.views[0]).toEqual({ id: 'v_1', kind: 'table', name: 'Table' });
  });

  it('retype a column, keeping what converts', () => {
    const asText = retypeColumn(tracker(), 'c_status', 'text');
    expect(asText.columns[0]).toEqual({
      id: 'c_status',
      kind: 'text',
      name: 'Status',
    });
    expect(asText.rows[0].c_status).toBe('Revising');
    const back = retypeColumn(asText, 'c_status', 'select');
    expect(back.columns[0].options?.map(({ name }) => name)).toEqual([
      'Revising',
    ]);
    expect(back.rows[0].c_status).toBe(back.columns[0].options?.[0].id);
    const marks = retypeColumn(tracker(), 'c_mark', 'text');
    expect(marks.rows[0].c_mark).toBe('6');
    expect(retypeColumn(marks, 'c_mark', 'number').rows[0].c_mark).toBe(6);
    expect(isTableViewBlock(back)).toBe(true);
  });

  it('add options with the next colour and delete them with their cells', () => {
    const { block, optionId } = addOption(tracker(), 'c_status', 'Done');
    expect(block.columns[0].options?.at(-1)).toEqual({
      color: 'yellow',
      id: optionId,
      name: 'Done',
    });
    expect(nextColor([])).toBe('gray');
    const gone = deleteOption(block, 'c_status', 'o_2');
    expect(gone.columns[0].options?.map(({ id }) => id)).toEqual([
      'o_1',
      optionId,
    ]);
    expect(gone.rows[0]).not.toHaveProperty('c_status');
  });

  it('add views, a Kanban grouped by the first select, and keep the last', () => {
    const { block, viewId } = addView(tracker(), 'kanban', 'Board');
    expect(block.views.at(-1)).toEqual({
      groupBy: 'c_status',
      id: viewId,
      kind: 'kanban',
      name: 'Board',
    });
    const one = deleteView(deleteView(block, 'v_1'), viewId);
    expect(one.views.map(({ id }) => id)).toEqual(['v_2']);
    expect(deleteView(one, 'v_2')).toBe(one);
  });

  it('group a Kanban by option, records without one first', () => {
    const block = tracker();
    const lanes = kanbanGroups(block, block.views[1]);
    expect(
      lanes.map(({ option, rows }) => [option?.id, rows.map(({ id }) => id)])
    ).toEqual([
      [undefined, ['r_2']],
      ['o_1', []],
      ['o_2', ['r_1']],
    ]);
  });

  it('move a card to another column’s option, or to none', () => {
    const moved = moveCard(tracker(), 'r_2', 'c_status', 'o_1');
    expect(moved.rows[1].c_status).toBe('o_1');
    const cleared = moveCard(moved, 'r_1', 'c_status', undefined);
    expect(cleared.rows[0]).not.toHaveProperty('c_status');
  });

  it('name new columns and views apart and read number fields', () => {
    expect(uniqueName('Column', ['Column', 'Column 2'])).toBe('Column 3');
    expect(parseNumber(' 7.5 ')).toBe(7.5);
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber(String(TABLE_VIEW_LIMITS.number * 10))).toBeNull();
  });
});
