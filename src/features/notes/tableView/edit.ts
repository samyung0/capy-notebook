import {
  type CellValue,
  type ColumnKind,
  cellValue,
  drawnColumns,
  groupColumn,
  newId,
  OPTION_COLORS,
  type OptionColor,
  type SelectOption,
  sortedRows,
  TABLE_VIEW_LIMITS,
  type TableViewBlock,
  type TableViewColumn,
  type TableViewRow,
  type TableViewView,
  type ViewKind,
  type ViewSort,
} from './model';

/* The table view editor's edits (Epo 2026-11-12, mock 9nQns9KAvwafQT2LyK7fHt):
   pure functions from a block to the next one. Each keeps the writers' rules
   (`isTableViewBlock`) when its `can*` check holds, and returns the same
   object when nothing changes, so the element writes nothing. Only the list
   entries an edit touches are new objects: the room's map rewrites just
   those. */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const canAddRow = (block: TableViewBlock) =>
  block.rows.length < TABLE_VIEW_LIMITS.rows;
export const canAddColumn = (block: TableViewBlock) =>
  block.columns.length < TABLE_VIEW_LIMITS.columns;
export const canAddView = (block: TableViewBlock) =>
  block.views.length < TABLE_VIEW_LIMITS.views;
export const canAddOption = (column: TableViewColumn) =>
  (column.options?.length ?? 0) < TABLE_VIEW_LIMITS.options;

export const titleColumn = (block: TableViewBlock) =>
  block.columns.find(({ kind }) => kind === 'title') as TableViewColumn;

/** `base`, or `base N` with the first N from 2 that no name in `names` has. */
export function uniqueName(base: string, names: string[]): string {
  if (!names.includes(base)) return base;
  for (let n = 2; ; n++)
    if (!names.includes(`${base} ${n}`)) return `${base} ${n}`;
}

export function setTitle(block: TableViewBlock, title: string): TableViewBlock {
  return block.title === title ? block : { ...block, title };
}

const mapColumn = (
  block: TableViewBlock,
  columnId: string,
  edit: (column: TableViewColumn) => TableViewColumn
): TableViewBlock => {
  let changed = false;
  const columns = block.columns.map((column) => {
    if (column.id !== columnId) return column;
    const next = edit(column);
    changed ||= next !== column;
    return next;
  });
  return changed ? { ...block, columns } : block;
};

const mapView = (
  block: TableViewBlock,
  viewId: string,
  edit: (view: TableViewView) => TableViewView
): TableViewBlock => {
  let changed = false;
  const views = block.views.map((view) => {
    if (view.id !== viewId) return view;
    const next = edit(view);
    changed ||= next !== view;
    return next;
  });
  return changed ? { ...block, views } : block;
};

/** A row's cells for its block's columns only: a merge or a deleted column
 * can leave others, which count toward the row's key cap. */
const liveCells = (block: TableViewBlock, row: TableViewRow) => {
  const ids = new Set(block.columns.map(({ id }) => id));
  return Object.fromEntries(
    Object.entries(row.cells).filter(([key]) => ids.has(key))
  );
};

/** One cell set, or emptied with `undefined`. */
export function setCell(
  block: TableViewBlock,
  rowId: string,
  columnId: string,
  value: CellValue | undefined
): TableViewBlock {
  const row = block.rows.find(({ id }) => id === rowId);
  if (!row || row.cells[columnId] === value) return block;
  if (value === undefined && !(columnId in row.cells)) return block;
  const cells = liveCells(block, row);
  if (value === undefined) delete cells[columnId];
  else cells[columnId] = value;
  return {
    ...block,
    rows: block.rows.map((item) => (item === row ? { ...row, cells } : item)),
  };
}

/** A new record at the end of the list, with `cells` filled in. */
export function addRow(
  block: TableViewBlock,
  cells: Record<string, CellValue> = {}
): { block: TableViewBlock; rowId: string } {
  const rowId = newId('r');
  return {
    block: { ...block, rows: [...block.rows, { cells, id: rowId }] },
    rowId,
  };
}

/** A new empty record next to `rowId`, above or below it in the list. */
export function insertRow(
  block: TableViewBlock,
  rowId: string,
  side: 'above' | 'below'
): { block: TableViewBlock; rowId: string } {
  const at = block.rows.findIndex(({ id }) => id === rowId);
  const id = newId('r');
  const rows = [...block.rows];
  rows.splice(side === 'above' ? at : at + 1, 0, { cells: {}, id });
  return { block: { ...block, rows }, rowId: id };
}

export function deleteRow(
  block: TableViewBlock,
  rowId: string
): TableViewBlock {
  const rows = block.rows.filter(({ id }) => id !== rowId);
  return rows.length === block.rows.length ? block : { ...block, rows };
}

export function newColumn(
  name: string,
  kind: Exclude<ColumnKind, 'title'> = 'text'
): TableViewColumn {
  return kind === 'select'
    ? { id: newId('c'), kind, name, options: [] }
    : { id: newId('c'), kind, name };
}

/** `column` placed left or right of `anchorId` as columns are drawn (the
 * title column first, whatever its place in the list), or at the end. */
export function insertColumn(
  block: TableViewBlock,
  column: TableViewColumn,
  anchor?: { columnId: string; side: 'left' | 'right' }
): TableViewBlock {
  const columns = [...block.columns];
  const drawn = drawnColumns(block);
  const at = anchor
    ? drawn.findIndex(({ id }) => id === anchor.columnId) +
      (anchor.side === 'right' ? 1 : 0)
    : drawn.length;
  // Nothing is drawn left of the title column.
  const before = drawn[Math.max(at, 1)];
  if (before) columns.splice(columns.indexOf(before), 0, column);
  else columns.push(column);
  return { ...block, columns };
}

export function renameColumn(
  block: TableViewBlock,
  columnId: string,
  name: string
): TableViewBlock {
  return mapColumn(block, columnId, (column) =>
    column.name === name ? column : { ...column, name }
  );
}

/** The colour after the last option's, from gray (mock SelectCell). */
export function nextColor(options: SelectOption[]): OptionColor {
  const last = options.at(-1);
  if (!last) return OPTION_COLORS[0];
  return OPTION_COLORS[
    (OPTION_COLORS.indexOf(last.color) + 1) % OPTION_COLORS.length
  ];
}

/** A cell as it reads after its column's retype: a number stays a number
 * (as text in a text column), text that names an option becomes that option,
 * an option becomes its name as text; the rest empties. */
function convert(
  value: CellValue | undefined,
  to: ColumnKind,
  options: SelectOption[]
): CellValue | undefined {
  if (value === undefined) return;
  switch (to) {
    case 'title':
    case 'text':
      return typeof value === 'boolean' ? undefined : String(value);
    case 'number':
      if (typeof value === 'number') return value;
      return typeof value === 'string'
        ? (parseNumber(value) ?? undefined)
        : undefined;
    case 'select': {
      const name = typeof value === 'boolean' ? '' : String(value).trim();
      return options.find((option) => option.name === name)?.id;
    }
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? value : undefined;
    case 'checkbox':
      return typeof value === 'boolean' ? value : undefined;
  }
}

/** A column retyped (never to or from the title kind). A select column made
 * from another takes an option per distinct value, up to the cap, so every
 * value that fits keeps showing. */
export function retypeColumn(
  block: TableViewBlock,
  columnId: string,
  kind: Exclude<ColumnKind, 'title'>
): TableViewBlock {
  const column = block.columns.find(({ id }) => id === columnId);
  if (!column || column.kind === kind || column.kind === 'title') return block;
  const read = (row: TableViewRow) => {
    const value = cellValue(column, row);
    if (column.kind !== 'select' || value === undefined) return value;
    return column.options?.find(({ id }) => id === value)?.name;
  };
  const options: SelectOption[] = [];
  if (kind === 'select')
    for (const row of block.rows) {
      const value = read(row);
      const name =
        typeof value === 'boolean' || value === undefined
          ? ''
          : String(value).trim();
      if (
        !name ||
        name.length > TABLE_VIEW_LIMITS.name ||
        options.some((option) => option.name === name) ||
        options.length >= TABLE_VIEW_LIMITS.options
      )
        continue;
      options.push({ color: nextColor(options), id: newId('o'), name });
    }
  const next: TableViewColumn =
    kind === 'select'
      ? { id: column.id, kind, name: column.name, options }
      : { id: column.id, kind, name: column.name };
  const rows = block.rows.map((row) => {
    const before = row.cells[columnId];
    const value = convert(read(row), kind, options);
    if (before === value) return row;
    const cells = liveCells(block, row);
    if (value === undefined) delete cells[columnId];
    else cells[columnId] = value;
    return { ...row, cells };
  });
  return {
    ...block,
    columns: block.columns.map((item) => (item === column ? next : item)),
    rows,
  };
}

/** A copy right of the column, its cells copied; a copy of the title column
 * is a text column. */
export function duplicateColumn(
  block: TableViewBlock,
  columnId: string
): TableViewBlock {
  const column = block.columns.find(({ id }) => id === columnId);
  if (!column) return block;
  const id = newId('c');
  const copy: TableViewColumn =
    column.kind === 'title'
      ? { id, kind: 'text', name: column.name }
      : { ...column, id };
  const withColumn = insertColumn(block, copy, { columnId, side: 'right' });
  return {
    ...withColumn,
    rows: block.rows.map((row) => {
      const value = row.cells[columnId];
      return value === undefined
        ? row
        : { ...row, cells: { ...liveCells(block, row), [id]: value } };
    }),
  };
}

/** A column and its cells gone; a sort on it goes too. The title column
 * stays. */
export function deleteColumn(
  block: TableViewBlock,
  columnId: string
): TableViewBlock {
  const column = block.columns.find(({ id }) => id === columnId);
  if (!column || column.kind === 'title') return block;
  return {
    ...block,
    columns: block.columns.filter((item) => item !== column),
    rows: block.rows.map((row) => {
      if (!(columnId in row.cells)) return row;
      const { [columnId]: _gone, ...cells } = row.cells;
      return { ...row, cells };
    }),
    views: block.views.map((view) => {
      if (view.sort?.columnId !== columnId) return view;
      const { sort: _sort, ...rest } = view;
      return rest;
    }),
  };
}

/** A new option on a select column, with the next colour. */
export function addOption(
  block: TableViewBlock,
  columnId: string,
  name: string
): { block: TableViewBlock; optionId: string } {
  const optionId = newId('o');
  return {
    block: mapColumn(block, columnId, (column) => {
      const options = column.options ?? [];
      return {
        ...column,
        options: [
          ...options,
          { color: nextColor(options), id: optionId, name },
        ],
      };
    }),
    optionId,
  };
}

export function updateOption(
  block: TableViewBlock,
  columnId: string,
  optionId: string,
  patch: Partial<Pick<SelectOption, 'color' | 'name'>>
): TableViewBlock {
  return mapColumn(block, columnId, (column) => {
    const option = column.options?.find(({ id }) => id === optionId);
    if (
      !option ||
      Object.entries(patch).every(
        ([key, value]) => option[key as keyof SelectOption] === value
      )
    )
      return column;
    return {
      ...column,
      options: column.options?.map((item) =>
        item === option ? { ...option, ...patch } : item
      ),
    };
  });
}

/** An option gone; cells naming it read as empty and are emptied. */
export function deleteOption(
  block: TableViewBlock,
  columnId: string,
  optionId: string
): TableViewBlock {
  const next = mapColumn(block, columnId, (column) => ({
    ...column,
    options: column.options?.filter(({ id }) => id !== optionId),
  }));
  if (next === block) return block;
  return {
    ...next,
    rows: next.rows.map((row) => {
      if (row.cells[columnId] !== optionId) return row;
      const { [columnId]: _gone, ...cells } = row.cells;
      return { ...row, cells };
    }),
  };
}

export function setSort(
  block: TableViewBlock,
  viewId: string,
  sort: ViewSort | undefined
): TableViewBlock {
  return mapView(block, viewId, (view) => {
    if (view.sort?.columnId === sort?.columnId && view.sort?.dir === sort?.dir)
      return view;
    const { sort: _sort, ...rest } = view;
    return sort ? { ...rest, sort } : rest;
  });
}

export function setGroupBy(
  block: TableViewBlock,
  viewId: string,
  columnId: string
): TableViewBlock {
  return mapView(block, viewId, (view) =>
    view.groupBy === columnId ? view : { ...view, groupBy: columnId }
  );
}

/** A new view at the end; a Kanban groups by the first select column. */
export function addView(
  block: TableViewBlock,
  kind: ViewKind,
  name: string
): { block: TableViewBlock; viewId: string } {
  const id = newId('v');
  const group = block.columns.find((column) => column.kind === 'select');
  const view: TableViewView =
    kind === 'kanban' && group
      ? { groupBy: group.id, id, kind, name }
      : { id, kind, name };
  return { block: { ...block, views: [...block.views, view] }, viewId: id };
}

export function renameView(
  block: TableViewBlock,
  viewId: string,
  name: string
): TableViewBlock {
  return mapView(block, viewId, (view) =>
    view.name === name ? view : { ...view, name }
  );
}

/** A view gone, never the last one. */
export function deleteView(
  block: TableViewBlock,
  viewId: string
): TableViewBlock {
  if (block.views.length <= 1) return block;
  const views = block.views.filter(({ id }) => id !== viewId);
  return views.length === block.views.length ? block : { ...block, views };
}

export type KanbanGroup = { option?: SelectOption; rows: TableViewRow[] };

/** A Kanban view's columns: one per option of its group column, in option
 * order, led by the records with no option when there are any. Rows keep the
 * view's order. */
export function kanbanGroups(
  block: TableViewBlock,
  view: TableViewView
): KanbanGroup[] {
  const column = groupColumn(block, view);
  if (!column) return [];
  const rows = sortedRows(block, view);
  const groups: KanbanGroup[] = (column.options ?? []).map((option) => ({
    option,
    rows: rows.filter((row) => cellValue(column, row) === option.id),
  }));
  const none = rows.filter((row) => cellValue(column, row) === undefined);
  return none.length ? [{ rows: none }, ...groups] : groups;
}

/** A Kanban card dropped on another group: its option there, or none for the
 * group of records without one. */
export const moveCard = (
  block: TableViewBlock,
  rowId: string,
  groupColumnId: string,
  optionId: string | undefined
) => setCell(block, rowId, groupColumnId, optionId);

/** A number field's text as a cell: empty, or a finite number within the
 * cap; `null` when it is neither. */
export function parseNumber(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return;
  const value = Number(trimmed);
  return Number.isFinite(value) && Math.abs(value) <= TABLE_VIEW_LIMITS.number
    ? value
    : null;
}
