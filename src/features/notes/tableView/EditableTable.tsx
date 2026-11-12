import { memo, useRef } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/Popover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { sameJson } from '@/lib/sameJson';
import { ColumnMenu } from './ColumnMenu';
import { type TableViewEdit, useTableView } from './context';
import {
  canAddColumn,
  canAddRow,
  deleteRow,
  insertColumn,
  insertRow,
  newColumn,
  parseNumber,
  setCell,
  uniqueName,
} from './edit';
import { DateEditor, SelectEditor } from './editors';
import { CellText, CheckboxMark, CommitInput, textCell } from './fields';
import { COLUMN_WIDTH, widthVars } from './look';
import {
  type CellValue,
  cellValue,
  drawnColumns,
  plainNumber,
  sortedRows,
  TABLE_VIEW_LIMITS,
  type TableViewColumn,
  type TableViewRow,
  type TableViewView,
} from './model';

type Write = (edit: TableViewEdit) => void;
/** The cell open for editing, in either view. */
export type Editing = { rowId: string; columnId: string } | null;

/** The same array while its JSON stays the same: a peer's change rebuilds
 * the whole block, and rows keep their drawing unless theirs changed. */
function useStable<T>(value: T): T {
  const held = useRef(value);
  if (!sameJson(held.current, value)) held.current = value;
  return held.current;
}

const CELL = 'h-9 border-line border-b p-0 align-middle';
/** The title column stays while the rest scroll sideways (mock Phone). */
const STICKY =
  'sticky left-0 z-[1] bg-surface shadow-[4px_0_6px_-4px_rgb(0_0_0/0.12)] sm:shadow-none';

/** The record's menu, from a pill at the end of its title cell, in the plain
 * table's style: insert above or below, delete. */
function RowMenu({
  room,
  row,
  write,
}: {
  /** Whether a record can be added (the rows cap). */
  room: boolean;
  row: TableViewRow;
  write: Write;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={m.table_view_record()}
        className="flex h-7 w-5 items-center justify-center rounded-full border border-line bg-surface text-fg-muted opacity-0 pointer-coarse:opacity-100 outline-none transition-opacity hover:bg-surface-hover-bg hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-action group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
        title={m.table_view_record()}
      >
        <Icon name="moreVertical" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-48"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
        side="right"
      >
        <DropdownMenuItem
          disabled={!room}
          onSelect={() =>
            write((block) => insertRow(block, row.id, 'above').block)
          }
        >
          <Icon name="arrowUp" />
          {m.table_view_insert_above()}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!room}
          onSelect={() =>
            write((block) => insertRow(block, row.id, 'below').block)
          }
        >
          <Icon name="arrowDown" />
          {m.table_view_insert_below()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-tint-error-fg"
          onSelect={() => write((block) => deleteRow(block, row.id))}
        >
          <Icon name="trash" />
          {m.table_view_delete_record()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A cell that edits in place: text and numbers in a field, select and date
 * in a popover, a checkbox on click. */
function Cell({
  column,
  editing,
  onEdit,
  row,
  write,
}: {
  column: TableViewColumn;
  editing: boolean;
  onEdit: (editing: Editing) => void;
  row: TableViewRow;
  write?: Write;
}) {
  const title = column.kind === 'title';
  const content = cn(
    'flex h-9 w-full min-w-0 items-center px-2.5 text-left',
    title && 'pointer-coarse:pr-8 font-semibold'
  );
  if (!write)
    return (
      <div className={content}>
        <CellText column={column} row={row} />
      </div>
    );
  const value = cellValue(column, row);
  const set = (next: CellValue | undefined) =>
    write((block) => setCell(block, row.id, column.id, next));
  const done = () => onEdit(null);
  if (column.kind === 'checkbox')
    return (
      <button
        aria-checked={value === true}
        aria-label={column.name}
        className={cn(
          content,
          'outline-none hover:bg-surface-hover-bg/60 focus-visible:bg-surface-hover-bg'
        )}
        onClick={() => set(value !== true)}
        role="checkbox"
        type="button"
      >
        <CheckboxMark checked={value === true} />
      </button>
    );
  if (editing && (title || column.kind === 'text' || column.kind === 'number'))
    return (
      <CommitInput
        aria-label={column.name}
        autoFocus
        className={cn(
          content,
          'outline-2 outline-action-accent -outline-offset-2'
        )}
        inputMode={column.kind === 'number' ? 'decimal' : undefined}
        maxLength={TABLE_VIEW_LIMITS.cell}
        onCommit={(text) =>
          set(
            column.kind === 'number'
              ? (parseNumber(text) ?? undefined)
              : textCell(text)
          )
        }
        onDone={done}
        parse={
          column.kind === 'number'
            ? (text) => parseNumber(text) !== null
            : undefined
        }
        value={
          value === undefined
            ? ''
            : typeof value === 'number'
              ? plainNumber(value)
              : String(value)
        }
      />
    );
  const button = (
    <button
      aria-label={column.name}
      className={cn(
        content,
        'outline-none hover:bg-surface-hover-bg/60 focus-visible:bg-surface-hover-bg',
        editing && 'outline-2 outline-action-accent -outline-offset-2'
      )}
      data-table-view-cell
      onClick={() => onEdit({ columnId: column.id, rowId: row.id })}
      type="button"
    >
      <CellText column={column} row={row} />
    </button>
  );
  if (column.kind !== 'select' && column.kind !== 'date') return button;
  return (
    <Popover
      modal={false}
      onOpenChange={(open) => !open && done()}
      open={editing}
    >
      <PopoverAnchor asChild>{button}</PopoverAnchor>
      {editing && (
        <PopoverContent
          align="start"
          className={cn('p-1.5', column.kind === 'select' ? 'w-65' : 'w-72')}
          data-plate-prevent-deselect
          onCloseAutoFocus={(event) => event.preventDefault()}
          sideOffset={2}
        >
          {column.kind === 'select' ? (
            <SelectEditor
              column={column}
              onPick={(optionId) => {
                set(optionId);
                done();
              }}
              value={value as string | undefined}
            />
          ) : (
            <DateEditor
              onPick={(iso) => {
                set(iso);
                done();
              }}
              value={value as string | undefined}
            />
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}

const Row = memo(
  function Row({
    columns,
    editing,
    onEdit,
    room,
    row,
    write,
  }: {
    columns: TableViewColumn[];
    /** The column whose cell is open in this row. */
    editing: string | undefined;
    onEdit: (editing: Editing) => void;
    room: boolean;
    row: TableViewRow;
    write?: Write;
  }) {
    return (
      <tr className="group/row">
        {columns.map((column, at) => (
          <td
            className={cn(CELL, at === 0 ? STICKY : 'border-l')}
            key={column.id}
          >
            <Cell
              column={column}
              editing={editing === column.id}
              onEdit={onEdit}
              row={row}
              write={write}
            />
            {at === 0 && write && (
              <div className="absolute top-1/2 right-1 flex -translate-y-1/2">
                <RowMenu room={room} row={row} write={write} />
              </div>
            )}
          </td>
        ))}
        {write && <td className={cn(CELL, 'border-l')} />}
      </tr>
    );
  },
  (prev, next) =>
    prev.columns === next.columns &&
    prev.editing === next.editing &&
    prev.room === next.room &&
    prev.write === next.write &&
    prev.onEdit === next.onEdit &&
    (prev.row === next.row || sameJson(prev.row, next.row))
);

/** The editor's Table view (mock Main): typed columns with their icons, a + to add
 * one, the records in the view's order and + New record under them. */
export function EditableTable({
  editing,
  onEdit,
  onNewRecord,
  view,
}: {
  editing: Editing;
  onNewRecord: () => void;
  /** Stable: rows redraw only when theirs changed. */
  onEdit: (editing: Editing) => void;
  view: TableViewView;
}) {
  const { block, write } = useTableView();
  const columns = useStable(drawnColumns(block));
  const rows = sortedRows(block, view);
  const room = canAddRow(block);
  // Fixed columns, the table at least as wide as the note: past it, the
  // columns after the title scroll sideways.
  const edge = write ? 36 : 0;
  const tableWidth = [0, 1].map((at) =>
    columns.reduce((sum, { kind }) => sum + COLUMN_WIDTH[kind][at], edge)
  ) as [number, number];
  const addColumn = () =>
    write?.((next) =>
      insertColumn(
        next,
        newColumn(
          uniqueName(
            m.table_view_column(),
            next.columns.map(({ name }) => name)
          )
        )
      )
    );
  return (
    <>
      <div className="overflow-x-auto">
        <table
          className="w-(--w-phone) min-w-full table-fixed border-separate border-spacing-0 text-sm sm:w-(--w-wide)"
          style={widthVars(tableWidth)}
        >
          <colgroup>
            {columns.map((column) => (
              <col
                className="w-(--w-phone) sm:w-(--w-wide)"
                key={column.id}
                style={widthVars(COLUMN_WIDTH[column.kind])}
              />
            ))}
            {write && <col className="w-9" />}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column, at) => (
                <th
                  className={cn(
                    CELL,
                    'text-left font-medium text-fg-muted',
                    at === 0 ? STICKY : 'border-l',
                    // The menu's trigger fills the header cell.
                    '*:data-[slot=dropdown-menu-anchor]:flex *:data-[slot=dropdown-menu-anchor]:h-9 *:data-[slot=dropdown-menu-anchor]:w-full'
                  )}
                  key={column.id}
                  scope="col"
                >
                  {write ? (
                    <ColumnMenu column={column} view={view} />
                  ) : (
                    <div className="flex h-9 items-center px-2.5">
                      <ColumnMenu column={column} view={view} />
                    </div>
                  )}
                </th>
              ))}
              {write && (
                <th className={cn(CELL, 'border-l')}>
                  <button
                    aria-label={m.table_view_add_column()}
                    className="flex h-9 w-full items-center justify-center text-fg-muted outline-none hover:bg-surface-hover-bg hover:text-fg focus-visible:bg-surface-hover-bg disabled:opacity-40"
                    disabled={!canAddColumn(block)}
                    onClick={addColumn}
                    title={m.table_view_add_column()}
                    type="button"
                  >
                    <Icon name="plus" />
                  </button>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row
                columns={columns}
                editing={
                  editing?.rowId === row.id ? editing.columnId : undefined
                }
                key={row.id}
                onEdit={onEdit}
                room={room}
                row={row}
                write={write}
              />
            ))}
          </tbody>
        </table>
      </div>
      {write && (
        <button
          className="flex h-10 w-full items-center gap-1.5 border-line border-b px-2.5 text-left text-fg-muted text-sm outline-none hover:bg-surface-hover-bg/60 hover:text-fg focus-visible:bg-surface-hover-bg disabled:opacity-40 sm:h-9"
          disabled={!room}
          onClick={onNewRecord}
          type="button"
        >
          <Icon name="plus" />
          {m.table_view_new_record()}
        </button>
      )}
    </>
  );
}
