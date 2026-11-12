import { describe, expect, it } from 'vitest';
import {
  cellText,
  cellValue,
  drawnColumns,
  isTableViewBlock,
  newTableViewBlock,
  plainNumber,
  sortedRows,
  TABLE_VIEW_LIMITS,
  type TableViewBlock,
  type TableViewColumn,
  type TableViewRow,
  tableViewText,
} from './model';
import { status, tracker } from './testFixtures';

const column = (kind: TableViewColumn['kind']): TableViewColumn => ({
  id: 'c',
  kind,
  name: kind,
  ...(kind === 'select' && { options: status.options }),
});
const row = (value: unknown, id = 'r'): TableViewRow =>
  ({ cells: value === undefined ? {} : { c: value }, id }) as TableViewRow;

describe('isTableViewBlock', () => {
  it('takes the spec example and the slash menu block', () => {
    expect(isTableViewBlock(tracker())).toBe(true);
    const names = {
      done: 'Done',
      kanban: 'Kanban',
      name: 'Name',
      notYet: 'Not yet',
      revising: 'Revising',
      status: 'Status',
      table: 'Table',
    };
    expect(isTableViewBlock(newTableViewBlock(names))).toBe(true);
  });

  it('takes a block at every limit', () => {
    const id = (prefix: string, n: number) =>
      `${prefix}${n}`.padEnd(TABLE_VIEW_LIMITS.id, '_');
    const name = 'n'.repeat(TABLE_VIEW_LIMITS.name);
    const columns: TableViewColumn[] = Array.from(
      { length: TABLE_VIEW_LIMITS.columns },
      (_, i) =>
        i === 0
          ? { id: id('c', i), kind: 'title', name }
          : {
              id: id('c', i),
              kind: 'select',
              name,
              options: Array.from(
                { length: TABLE_VIEW_LIMITS.options },
                (_, o) => ({ color: 'red', id: id('o', o), name })
              ),
            }
    );
    const cells = Object.fromEntries(
      columns.map((c, i) => [
        c.id,
        i === 0
          ? 'x'.repeat(TABLE_VIEW_LIMITS.cell)
          : -TABLE_VIEW_LIMITS.number,
      ])
    );
    const block: TableViewBlock = {
      columns,
      rows: Array.from({ length: TABLE_VIEW_LIMITS.rows }, (_, i) => ({
        cells,
        id: id('r', i),
      })),
      title: name,
      views: Array.from({ length: TABLE_VIEW_LIMITS.views }, (_, i) => ({
        id: id('v', i),
        kind: 'table',
        name,
      })),
    };
    expect(isTableViewBlock(block)).toBe(true);
  });

  it('takes what merges leave: a cell of a gone column, a misfit value, a stale sort', () => {
    const block = tracker();
    block.rows[0].cells.c_gone = 'left';
    block.rows[0].cells.c_mark = 'six';
    block.rows[0].cells.c_status = 'o_gone';
    block.views[0].sort = { columnId: 'c_gone', dir: 'desc' };
    block.views[1].groupBy = 'c_title';
    expect(isTableViewBlock(block)).toBe(true);
  });

  it.each<[string, (block: TableViewBlock) => unknown]>([
    ['two title columns', (b) => b.columns.push(column('title'))],
    ['no title column', (b) => b.columns.splice(1, 1)],
    [
      'too many columns',
      (b) => {
        for (let i = b.columns.length; i <= TABLE_VIEW_LIMITS.columns; i++)
          b.columns.push({ id: `c${i}`, kind: 'text', name: '' });
      },
    ],
    [
      'too many rows',
      (b) => {
        for (let i = b.rows.length; i <= TABLE_VIEW_LIMITS.rows; i++)
          b.rows.push({ cells: {}, id: `r${i}` });
      },
    ],
    ['no view', (b) => b.views.splice(0)],
    ['a bad column kind', (b) => Object.assign(b.columns[2], { kind: 'url' })],
    ['a bad view kind', (b) => Object.assign(b.views[0], { kind: 'gallery' })],
    [
      'a bad colour',
      (b) => Object.assign(b.columns[0].options![0], { color: 'teal' }),
    ],
    ['a bad id', (b) => Object.assign(b.rows[0], { id: 'r 1' })],
    [
      'an id too long',
      (b) =>
        Object.assign(b.rows[0], { id: 'r'.repeat(TABLE_VIEW_LIMITS.id + 1) }),
    ],
    ['a duplicate row id', (b) => b.rows.push({ cells: {}, id: 'r_1' })],
    [
      'a duplicate option id',
      (b) => b.columns[0].options!.push({ color: 'red', id: 'o_1', name: '' }),
    ],
    ['an unknown block key', (b) => Object.assign(b, { icon: 'x' })],
    ['an unknown row key', (b) => Object.assign(b.rows[0], { color: 'red' })],
    [
      'options on a text column',
      (b) => Object.assign(b.columns[2], { options: [] }),
    ],
    [
      'a select without options',
      (b) => Object.assign(b.columns[0], { options: undefined }),
    ],
    [
      'groupBy on a table view',
      (b) => Object.assign(b.views[0], { groupBy: 'c_status' }),
    ],
    [
      'a bad sort dir',
      (b) =>
        Object.assign(b.views[0], { sort: { columnId: 'c_mark', dir: 'up' } }),
    ],
    ['a null cell', (b) => Object.assign(b.rows[0].cells, { c_mark: null })],
    [
      'a number over the cap',
      (b) =>
        Object.assign(b.rows[0].cells, {
          c_mark: TABLE_VIEW_LIMITS.number * 10,
        }),
    ],
    [
      'a cell too long',
      (b) =>
        Object.assign(b.rows[0].cells, {
          c_title: 'x'.repeat(TABLE_VIEW_LIMITS.cell + 1),
        }),
    ],
    [
      'a name too long',
      (b) =>
        Object.assign(b, { title: 'x'.repeat(TABLE_VIEW_LIMITS.name + 1) }),
    ],
  ])('refuses %s', (_, change) => {
    const block = tracker();
    change(block);
    expect(isTableViewBlock(block)).toBe(false);
  });
});

describe('reading cells', () => {
  it('reads a value that fits its column and tolerates the spec cases', () => {
    expect(cellValue(column('text'), row(6))).toBe('6');
    expect(cellValue(column('number'), row(' -2.5 '))).toBe(-2.5);
    expect(cellValue(column('number'), row('six'))).toBeUndefined();
    expect(cellValue(column('select'), row('o_2'))).toBe('o_2');
    expect(cellValue(column('select'), row('o_gone'))).toBeUndefined();
    expect(cellValue(column('date'), row('2026-11-10'))).toBe('2026-11-10');
    expect(cellValue(column('date'), row('2026-02-30'))).toBeUndefined();
    expect(cellValue(column('date'), row('2026-13-01'))).toBeUndefined();
    expect(cellValue(column('checkbox'), row(true))).toBe(true);
    expect(cellValue(column('checkbox'), row('true'))).toBeUndefined();
    expect(cellValue(column('title'), row(undefined))).toBeUndefined();
  });

  it('writes a cell as text: option names, ISO dates, boxes, plain numbers', () => {
    expect(cellText(column('select'), row('o_3'))).toBe('Done');
    expect(cellText(column('checkbox'), row(true))).toBe('☑');
    expect(cellText(column('checkbox'), row(undefined))).toBe('☐');
    expect(cellText(column('date'), row('2026-11-10'))).toBe('2026-11-10');
    expect(cellText(column('number'), row(1e-7))).toBe('0.0000001');
    expect(cellText(column('text'), row(-0))).toBe('0');
  });

  it('writes numbers as plain decimals', () => {
    expect(plainNumber(1e15)).toBe('1000000000000000');
    expect(plainNumber(-1.5e-10)).toBe('-0.00000000015');
    expect(plainNumber(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(plainNumber(1.25e21)).toBe('1250000000000000000000');
  });

  it('draws the title column first', () => {
    expect(drawnColumns(tracker()).map(({ id }) => id)).toEqual([
      'c_title',
      'c_status',
      'c_mark',
      'c_review',
      'c_done',
    ]);
  });
});

describe('sortedRows', () => {
  const block = (
    sort?: TableViewBlock['views'][0]['sort']
  ): TableViewBlock => ({
    columns: [
      { id: 'c', kind: 'title', name: 'Name' },
      { id: 'n', kind: 'number', name: 'N' },
      status,
    ],
    rows: [
      { cells: { c: 'a', c_status: 'o_3', n: 2 }, id: 'a' },
      { cells: { c: 'b' }, id: 'b' },
      { cells: { c: 'c', c_status: 'o_1', n: 1 }, id: 'c' },
      { cells: { c: 'd', n: 2 }, id: 'd' },
      { cells: { c: 'e', n: 'x' }, id: 'e' },
    ],
    title: '',
    views: [{ id: 'v', kind: 'table', name: 'T', ...(sort && { sort }) }],
  });
  const order = (b: TableViewBlock) =>
    sortedRows(b, b.views[0]).map(({ id }) => id);

  it('keeps list order without a valid sort', () => {
    expect(order(block())).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(order(block({ columnId: 'gone', dir: 'asc' }))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('puts empty cells last either way and keeps ties in list order', () => {
    expect(order(block({ columnId: 'n', dir: 'asc' }))).toEqual([
      'c',
      'a',
      'd',
      'b',
      'e',
    ]);
    expect(order(block({ columnId: 'n', dir: 'desc' }))).toEqual([
      'a',
      'd',
      'c',
      'b',
      'e',
    ]);
  });

  it('sorts a select column by its options order', () => {
    expect(order(block({ columnId: 'c_status', dir: 'asc' }))).toEqual([
      'c',
      'a',
      'b',
      'd',
      'e',
    ]);
  });
});

describe('tableViewText', () => {
  it('is the title, a blank line and the first view as a Markdown table', () => {
    expect(tableViewText(tracker())).toBe(
      [
        'Revision tracker',
        '',
        '| Topic | Status | Mark | Review on | Done |',
        '| --- | --- | --- | --- | --- |',
        '| Krebs cycle | Revising | 6 | 2026-11-10 | ☐ |',
        '| Glycolysis \\| ATP | Done |  |  | ☑ |',
      ].join('\n')
    );
  });

  it('leaves out a blank title and puts line breaks as spaces', () => {
    const block = tracker();
    block.title = ' \n ';
    block.rows = [{ cells: { c_title: 'two\nlines\r\nhere' }, id: 'r' }];
    expect(tableViewText(block)).toBe(
      [
        '| Topic | Status | Mark | Review on | Done |',
        '| --- | --- | --- | --- | --- |',
        '| two lines here |  |  |  | ☐ |',
      ].join('\n')
    );
  });
});
