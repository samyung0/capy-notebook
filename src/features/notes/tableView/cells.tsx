import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  COLUMN_ICON,
  OPTION_CHIP_CLASS,
  OPTION_CHIP_SHAPE,
  tableViewDate,
} from './display';
import {
  cellOption,
  cellValue,
  plainNumber,
  type SelectOption,
  type TableViewColumn,
  type TableViewRow,
} from './model';

/* A table view's cells and header labels as every table draws them: the
   editor's, its record dialog and the read-only table (a note's View, share
   pages in the Worker). No state or browser API. */

/** A column header's label: its type's icon and its name. */
export function ColumnLabel({ column }: { column: TableViewColumn }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="shrink-0" name={COLUMN_ICON[column.kind]} />
      <span className="truncate">{column.name}</span>
    </span>
  );
}

/** A select option as its colour chip, with × to clear when `onClear`. */
export function OptionChip({
  className,
  onClear,
  option,
}: {
  className?: string;
  onClear?: () => void;
  option: SelectOption;
}) {
  return (
    <span
      className={cn(
        OPTION_CHIP_SHAPE,
        'gap-1',
        onClear && 'pr-1',
        OPTION_CHIP_CLASS[option.color],
        className
      )}
    >
      <span className="truncate">{option.name}</span>
      {onClear && (
        <button
          aria-label={m.table_view_clear()}
          className="-my-px flex shrink-0 rounded-sm opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-action"
          onClick={onClear}
          type="button"
        >
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}

/** A checkbox cell's box. */
export function CheckboxMark({ checked }: { checked: boolean }) {
  return checked ? (
    <span
      aria-label={m.table_view_checked()}
      className="inline-flex size-4 items-center justify-center rounded bg-fg align-middle text-surface"
      role="img"
    >
      <Icon name="tick" size={12} strokeWidth={3} />
    </span>
  ) : (
    <span
      aria-label={m.table_view_unchecked()}
      className="inline-block size-4 rounded border-[1.5px] border-line-strong align-middle"
      role="img"
    />
  );
}

/** A cell's value as drawn (spec "How readers draw it") on one line; an
 * empty cell is blank. */
export function CellText({
  column,
  row,
}: {
  column: TableViewColumn;
  row: TableViewRow;
}) {
  const value = cellValue(column, row);
  if (column.kind === 'checkbox') return <CheckboxMark checked={!!value} />;
  if (value === undefined || value === '') return null;
  if (column.kind === 'select') {
    const option = cellOption(column, row);
    return option ? <OptionChip option={option} /> : null;
  }
  const text =
    column.kind === 'date'
      ? tableViewDate(String(value))
      : typeof value === 'number'
        ? plainNumber(value)
        : String(value);
  return <span className="truncate">{text}</span>;
}
