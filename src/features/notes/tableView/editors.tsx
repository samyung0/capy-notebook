import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { MiniCalendar } from '@/features/schedule/MiniCalendar';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { OptionChip } from './cells';
import { keepKeys, useTableView } from './context';
import {
  addOption,
  canAddOption,
  deleteOption,
  nextColor,
  updateOption,
} from './edit';
import { isoDate, OPTION_COLOR_LABEL, parseIsoDate } from './look';
import {
  OPTION_COLORS,
  type SelectOption,
  TABLE_VIEW_LIMITS,
  type TableViewColumn,
} from './model';

const ROW =
  'flex h-8 w-full items-center gap-2 rounded-button px-1.5 text-left text-sm outline-none';

/** An option's ⋯ menu: its name, its colour, Delete (mock SelectCell). */
function OptionMenu({
  column,
  option,
}: {
  column: TableViewColumn;
  option: SelectOption;
}) {
  const { write } = useTableView();
  const [name, setName] = useState(option.name);
  if (!write) return null;
  const rename = () => {
    const next = name.trim();
    if (next && next !== option.name)
      write((block) =>
        updateOption(block, column.id, option.id, { name: next })
      );
    else setName(option.name);
  };
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => !open && rename()}>
      <DropdownMenuTrigger
        aria-label={m.table_view_option_menu()}
        className="flex size-7 shrink-0 items-center justify-center rounded-button text-fg-muted outline-none hover:bg-surface-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-action"
      >
        <Icon name="moreHorizontal" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-52"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
        side="right"
      >
        <div className="p-1 pb-1.5">
          <Input
            aria-label={m.table_view_option_name()}
            maxLength={TABLE_VIEW_LIMITS.name}
            onBlur={rename}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              keepKeys(event);
              if (event.key === 'Enter') rename();
            }}
            size="sm"
            value={name}
            wrapperClassName="h-8"
          />
        </div>
        {OPTION_COLORS.map((color) => (
          <DropdownMenuItem
            key={color}
            onSelect={() =>
              write((block) =>
                updateOption(block, column.id, option.id, { color })
              )
            }
          >
            <OptionChip
              className="size-4.5 p-0"
              option={{ ...option, color, name: '' }}
            />
            {OPTION_COLOR_LABEL[color]()}
            {color === option.color && (
              <Icon className="ml-auto" name="check" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-tint-error-fg"
          onSelect={() =>
            write((block) => deleteOption(block, column.id, option.id))
          }
        >
          <Icon name="trash" />
          {m.table_view_delete_option()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A select cell's editor (mock SelectCell): the chosen option with ×, a
 * field that filters the options, Create for a new name. One option a cell;
 * picking one closes the editor. */
export function SelectEditor({
  column,
  onPick,
  value,
}: {
  column: TableViewColumn;
  /** An option id, or `undefined` to clear. */
  onPick: (optionId: string | undefined) => void;
  value: string | undefined;
}) {
  const { write } = useTableView();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const options = column.options ?? [];
  const typed = query.trim();
  const shown = options.filter((option) =>
    option.name.toLowerCase().includes(typed.toLowerCase())
  );
  const creatable =
    !!typed &&
    !options.some((option) => option.name === typed) &&
    canAddOption(column);
  const count = shown.length + (creatable ? 1 : 0);
  const current = options.find(({ id }) => id === value);
  const create = () => {
    if (!write) return;
    let id = '';
    write((block) => {
      const next = addOption(block, column.id, typed);
      id = next.optionId;
      return next.block;
    });
    onPick(id);
  };
  const pick = (at: number) => {
    if (at < shown.length) onPick(shown[at].id);
    else if (creatable) create();
  };
  return (
    <div className="flex flex-col">
      <div className="mb-1 flex min-h-9 flex-wrap items-center gap-1.5 border-divider border-b px-1.5 pb-1.5">
        {current && (
          <OptionChip onClear={() => onPick(undefined)} option={current} />
        )}
        <input
          aria-label={m.table_view_find_option()}
          autoFocus
          className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
          maxLength={TABLE_VIEW_LIMITS.name}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            keepKeys(event);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((at) => (count ? (at + step + count) % count : 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              pick(active);
            }
          }}
          placeholder={current ? '' : m.table_view_find_option()}
          value={query}
        />
      </div>
      <div className="flex max-h-72 flex-col overflow-y-auto">
        {shown.map((option, at) => (
          <div
            className={cn(
              ROW,
              'pr-0.5 hover:bg-overlay-hover',
              at === active && 'bg-overlay-hover'
            )}
            key={option.id}
            onPointerMove={() => setActive(at)}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-2 self-stretch outline-none"
              onClick={() => onPick(option.id)}
              type="button"
            >
              <OptionChip option={option} />
              {option.id === value && (
                <Icon className="ml-auto text-fg-muted" name="check" />
              )}
            </button>
            {write && <OptionMenu column={column} option={option} />}
          </div>
        ))}
        {creatable && (
          <button
            className={cn(
              ROW,
              'text-fg-muted hover:bg-overlay-hover',
              active === shown.length && 'bg-overlay-hover'
            )}
            onClick={create}
            onPointerMove={() => setActive(shown.length)}
            type="button"
          >
            {m.table_view_create()}
            <OptionChip
              option={{ color: nextColor(options), id: '', name: typed }}
            />
          </button>
        )}
      </div>
    </div>
  );
}

/** A date cell's editor: the app's calendar and Clear. */
export function DateEditor({
  onPick,
  value,
}: {
  onPick: (iso: string | undefined) => void;
  value: string | undefined;
}) {
  const selected = value ? parseIsoDate(value) : undefined;
  const [month, setMonth] = useState(() => {
    const day = selected ?? new Date();
    return new Date(day.getFullYear(), day.getMonth(), 1);
  });
  return (
    <div className="flex flex-col gap-1">
      <MiniCalendar
        month={month}
        onMonthChange={setMonth}
        onSelect={(day) => onPick(isoDate(day))}
        selected={selected}
      />
      {value && (
        <Button
          className="self-end"
          onClick={() => onPick(undefined)}
          size="sm"
          variant="ghost-hover"
        >
          {m.table_view_clear()}
        </Button>
      )}
    </div>
  );
}
