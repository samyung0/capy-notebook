import { EMBED_CATALOG } from '@/api/embeds.generated';

/* A note's table view (Epo 2026-11-12, mock 9nQns9KAvwafQT2LyK7fHt): AFFiNE's
   database look as a Plate block. The element holds its block as a live map
   whose columns, rows and views merge entry by entry (the catalog's
   sharedLists). Writers keep the structural rules (`isTableViewBlock`);
   readers draw what merges leave (cells of deleted columns, values that no
   longer fit their column) as empty instead of refusing them. */

const limits = EMBED_CATALOG.limits;
export const TABLE_VIEW_LIMITS = {
  cell: limits.TABLE_VIEW_CELL_MAX,
  columns: limits.TABLE_VIEW_COLUMNS_MAX,
  count: limits.TABLE_VIEW_MAX_COUNT,
  id: limits.TABLE_VIEW_ID_MAX,
  name: limits.TABLE_VIEW_NAME_MAX,
  number: limits.TABLE_VIEW_NUMBER_MAX,
  options: limits.TABLE_VIEW_OPTIONS_MAX,
  rows: limits.TABLE_VIEW_ROWS_MAX,
  views: limits.TABLE_VIEW_VIEWS_MAX,
} as const;

export const COLUMN_KINDS = [
  'title',
  'text',
  'number',
  'select',
  'date',
  'checkbox',
] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export const VIEW_KINDS = ['table', 'kanban'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export const OPTION_COLORS = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export type SelectOption = { id: string; name: string; color: OptionColor };

export type TableViewColumn = {
  id: string;
  name: string;
  kind: ColumnKind;
  /** On a select column only. */
  options?: SelectOption[];
};

export type CellValue = string | number | boolean;

export type TableViewRow = { id: string; cells: Record<string, CellValue> };

export type ViewSort = { columnId: string; dir: 'asc' | 'desc' };

export type TableViewView = {
  id: string;
  name: string;
  kind: ViewKind;
  sort?: ViewSort;
  /** On a kanban view: the select column it groups by. */
  groupBy?: string;
};

export type TableViewBlock = {
  title: string;
  columns: TableViewColumn[];
  rows: TableViewRow[];
  views: TableViewView[];
};

export type TableViewElement = {
  type: 'table_view';
  id: string;
  block: TableViewBlock;
  children: [{ text: '' }];
};

const ID = /^[A-Za-z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= TABLE_VIEW_LIMITS.id &&
  ID.test(value);

const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= TABLE_VIEW_LIMITS.name;

const uniqueIds = (items: { id: string }[]) =>
  new Set(items.map(({ id }) => id)).size === items.length;

const isCell = (value: unknown): value is CellValue =>
  typeof value === 'boolean' ||
  (typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= TABLE_VIEW_LIMITS.number) ||
  (typeof value === 'string' && value.length <= TABLE_VIEW_LIMITS.cell);

function isOption(value: unknown): value is SelectOption {
  return (
    isRecord(value) &&
    hasOnly(value, ['id', 'name', 'color']) &&
    isId(value.id) &&
    isName(value.name) &&
    OPTION_COLORS.includes(value.color as OptionColor)
  );
}

function isColumn(value: unknown): value is TableViewColumn {
  if (!(isRecord(value) && hasOnly(value, ['id', 'name', 'kind', 'options'])))
    return false;
  if (!(isId(value.id) && isName(value.name))) return false;
  if (!COLUMN_KINDS.includes(value.kind as ColumnKind)) return false;
  if (value.kind !== 'select') return value.options === undefined;
  return (
    Array.isArray(value.options) &&
    value.options.length <= TABLE_VIEW_LIMITS.options &&
    value.options.every(isOption) &&
    uniqueIds(value.options as SelectOption[])
  );
}

function isRow(value: unknown): value is TableViewRow {
  if (!(isRecord(value) && hasOnly(value, ['id', 'cells']) && isId(value.id)))
    return false;
  const { cells } = value;
  if (!isRecord(cells)) return false;
  const keys = Object.keys(cells);
  return (
    keys.length <= TABLE_VIEW_LIMITS.columns &&
    keys.every((key) => isId(key) && isCell(cells[key]))
  );
}

function isView(value: unknown): value is TableViewView {
  if (
    !(
      isRecord(value) &&
      hasOnly(value, ['id', 'name', 'kind', 'sort', 'groupBy']) &&
      isId(value.id) &&
      isName(value.name) &&
      VIEW_KINDS.includes(value.kind as ViewKind)
    )
  )
    return false;
  const { groupBy, sort } = value;
  if (groupBy !== undefined && !(value.kind === 'kanban' && isId(groupBy)))
    return false;
  return (
    sort === undefined ||
    (isRecord(sort) &&
      hasOnly(sort, ['columnId', 'dir']) &&
      isId(sort.columnId) &&
      (sort.dir === 'asc' || sort.dir === 'desc'))
  );
}

/** The structural rules every writer keeps (the spec's "What a writer must
 * keep"): what merges leave behind (a cell of a deleted column, a value that
 * no longer fits) still passes. */
export function isTableViewBlock(value: unknown): value is TableViewBlock {
  if (
    !(isRecord(value) && hasOnly(value, ['title', 'columns', 'rows', 'views']))
  )
    return false;
  const { columns, rows, title, views } = value;
  if (!isName(title)) return false;
  if (
    !(
      Array.isArray(columns) &&
      columns.length >= 1 &&
      columns.length <= TABLE_VIEW_LIMITS.columns &&
      columns.every(isColumn) &&
      uniqueIds(columns) &&
      columns.filter((column) => column.kind === 'title').length === 1
    )
  )
    return false;
  if (
    !(
      Array.isArray(rows) &&
      rows.length <= TABLE_VIEW_LIMITS.rows &&
      rows.every(isRow) &&
      uniqueIds(rows)
    )
  )
    return false;
  return (
    Array.isArray(views) &&
    views.length >= 1 &&
    views.length <= TABLE_VIEW_LIMITS.views &&
    views.every(isView) &&
    uniqueIds(views)
  );
}

/** Columns as drawn: the title column first, the rest in list order. */
export const drawnColumns = (block: TableViewBlock) => [
  ...block.columns.filter(({ kind }) => kind === 'title'),
  ...block.columns.filter(({ kind }) => kind !== 'title'),
];

/** A cell as its column reads it, or `undefined` when it is empty or doesn't
 * fit (a merge or a type change left it): a number shows in a text column, and
 * a decimal number written as text shows in a number column. */
export function cellValue(
  column: TableViewColumn,
  row: TableViewRow
): CellValue | undefined {
  const value = row.cells[column.id];
  switch (column.kind) {
    case 'title':
    case 'text':
      if (typeof value === 'string') return value;
      return typeof value === 'number' ? String(value) : undefined;
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return;
      return Number(value);
    }
    case 'select':
      return typeof value === 'string' &&
        column.options?.some(({ id }) => id === value)
        ? value
        : undefined;
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? value : undefined;
    case 'checkbox':
      return typeof value === 'boolean' ? value : undefined;
  }
}

/** The option a select cell names, if it still exists. */
export const cellOption = (column: TableViewColumn, row: TableViewRow) => {
  const value = cellValue(column, row);
  return column.options?.find(({ id }) => id === value);
};

/** A cell as plain text (index text, Markdown, exports): option names, ISO
 * dates, ☑/☐ for checkboxes, '' when empty. */
export function cellText(column: TableViewColumn, row: TableViewRow): string {
  const value = cellValue(column, row);
  if (value === undefined) return column.kind === 'checkbox' ? '☐' : '';
  if (column.kind === 'select') return cellOption(column, row)?.name ?? '';
  if (column.kind === 'checkbox') return value ? '☑' : '☐';
  return String(value);
}

/** The view's sort column, when it still names one. */
const sortColumn = (block: TableViewBlock, view: TableViewView) =>
  view.sort && block.columns.find(({ id }) => id === view.sort?.columnId);

/** Rows in the view's order: its sort when valid (empty cells last, ties keep
 * list order), else list order. */
export function sortedRows(
  block: TableViewBlock,
  view: TableViewView
): TableViewRow[] {
  const column = sortColumn(block, view);
  if (!(column && view.sort)) return block.rows;
  const dir = view.sort.dir === 'asc' ? 1 : -1;
  const rank = (row: TableViewRow) => {
    if (column.kind === 'select') {
      const at = column.options?.findIndex(
        ({ id }) => id === cellValue(column, row)
      );
      return at === undefined || at < 0 ? undefined : at;
    }
    const value = cellValue(column, row);
    if (value === undefined || value === '') return;
    return typeof value === 'boolean' ? Number(value) : value;
  };
  return block.rows
    .map((row, index) => ({ index, rank: rank(row), row }))
    .sort((a, b) => {
      if (a.rank === undefined || b.rank === undefined)
        return a.rank === undefined
          ? b.rank === undefined
            ? a.index - b.index
            : 1
          : -1;
      const order =
        typeof a.rank === 'number' && typeof b.rank === 'number'
          ? a.rank - b.rank
          : String(a.rank).localeCompare(String(b.rank));
      return order * dir || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** A Kanban view's group column, when it still names a select column. */
export const groupColumn = (block: TableViewBlock, view: TableViewView) =>
  block.columns.find(
    ({ id, kind }) => id === view.groupBy && kind === 'select'
  );

const escapeCell = (text: string) =>
  text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** The index text (spec "Index text"): the title as a line, then the first
 * view's rows as a Markdown table. */
export function tableViewText(block: TableViewBlock): string {
  const columns = drawnColumns(block);
  const view = block.views[0];
  const rows = view ? sortedRows(block, view) : block.rows;
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  return [
    ...(block.title.trim() ? [block.title.trim(), ''] : []),
    line(columns.map(({ name }) => name)),
    line(columns.map(() => '---')),
    ...rows.map((row) => line(columns.map((column) => cellText(column, row)))),
  ].join('\n');
}

let counter = 0;
/** A fresh id with a kind's prefix ("c", "r", "v", "o"). */
export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;

/** The block the slash menu's Table view inserts (spec "The editor"). The
 * names are the caller's (translated) strings. */
export function newTableViewBlock(names: {
  done: string;
  kanban: string;
  name: string;
  notYet: string;
  revising: string;
  status: string;
  table: string;
}): TableViewBlock {
  const status = newId('c');
  return {
    columns: [
      { id: newId('c'), kind: 'title', name: names.name },
      {
        id: status,
        kind: 'select',
        name: names.status,
        options: [
          { color: 'gray', id: newId('o'), name: names.notYet },
          { color: 'orange', id: newId('o'), name: names.revising },
          { color: 'green', id: newId('o'), name: names.done },
        ],
      },
    ],
    rows: [{ cells: {}, id: newId('r') }],
    title: '',
    views: [
      { id: newId('v'), kind: 'table', name: names.table },
      { groupBy: status, id: newId('v'), kind: 'kanban', name: names.kanban },
    ],
  };
}
