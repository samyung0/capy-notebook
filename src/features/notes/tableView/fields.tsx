import { useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { keepKeys } from './context';
import { OPTION_CHIP_CLASS, OPTION_CHIP_SHAPE, tableViewDate } from './display';
import {
  type CellValue,
  cellOption,
  cellValue,
  plainNumber,
  type SelectOption,
  type TableViewColumn,
  type TableViewRow,
} from './model';

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

/** A checkbox cell's box, as the read-only table draws it. */
export function CheckboxMark({ checked }: { checked: boolean }) {
  return checked ? (
    <span className="inline-flex size-4 items-center justify-center rounded bg-fg align-middle text-surface">
      <Icon name="tick" size={12} strokeWidth={3} />
    </span>
  ) : (
    <span className="inline-block size-4 rounded border-[1.5px] border-line-strong align-middle" />
  );
}

/** A cell's value as drawn (spec "How readers draw it"), as the read-only
 * table draws it on one line; an empty cell is blank. */
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

/** A text field that writes on Enter or leaving it; Escape drops the draft. */
export function CommitInput({
  className,
  onCommit,
  onDone,
  parse,
  value,
  ...rest
}: Omit<
  React.ComponentProps<'input'>,
  'value' | 'onChange' | 'defaultValue'
> & {
  value: string;
  onCommit: (text: string) => void;
  /** After a commit or Escape. */
  onDone?: () => void;
  /** False when the text cannot be written (the draft stays). */
  parse?: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [held, setHeld] = useState(value);
  // A peer's change shows while the field holds no edit of its own.
  if (value !== held) {
    setHeld(value);
    if (draft === held) setDraft(value);
  }
  const cancelled = useRef(false);
  const commit = () => {
    if (!cancelled.current && draft !== value && (!parse || parse(draft)))
      onCommit(draft);
    else setDraft(value);
    cancelled.current = false;
    onDone?.();
  };
  return (
    <input
      className={cn(
        'min-w-0 bg-transparent outline-none placeholder:text-placeholder',
        className
      )}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        keepKeys(event);
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      value={draft}
      {...rest}
    />
  );
}

/** A cell value from a typed text: empty clears it. */
export const textCell = (text: string): CellValue | undefined =>
  text === '' ? undefined : text;
