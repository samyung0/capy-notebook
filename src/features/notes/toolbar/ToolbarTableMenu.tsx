import { TablePlugin, useTableMergeState } from '@platejs/table/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Combine,
  Grid3X3,
  Table2,
  Trash2,
  Ungroup,
  X,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { cn } from '@/lib/cn';

export function TableMenu() {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton active={open} label="Table controls">
          <Table2 />
        </ToolbarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-45">
        <TableMenuItems onClose={() => setOpen(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Split out so the document subscriptions live under `DropdownMenuContent`,
 * which Radix does not render while the menu is closed. `useTableMergeState`
 * reads the selected cells through `useEditorSelector` with reference equality
 * over a freshly built array, so it reports a change on every edit; reading it
 * from the always-mounted toolbar button re-rendered this entire menu on every
 * keystroke, open or not.
 */
function TableMenuItems({ onClose }: { onClose: () => void }) {
  const { editor, tf } = useEditorPlugin(TablePlugin);
  const tableSelected = useEditorSelector(
    (currentEditor) => currentEditor.api.some({ match: { type: KEYS.table } }),
    []
  );
  const { canMerge, canSplit } = useTableMergeState();

  const run = (action: () => void) => {
    action();
    editor.tf.focus();
  };

  return (
    <DropdownMenuGroup>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Grid3X3 />
          <span>Table</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-auto p-0">
          <TablePicker
            onInsert={(rowCount, colCount) => {
              run(() =>
                tf.insert.table({ colCount, rowCount }, { select: true })
              );
              onClose();
            }}
          />
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!tableSelected}>
          <span className="size-4" />
          <span>Cell</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem
            disabled={!canMerge}
            onSelect={() => run(() => tf.table.merge())}
          >
            <Combine />
            Merge cells
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canSplit}
            onSelect={() => run(() => tf.table.split())}
          >
            <Ungroup />
            Split cell
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!tableSelected}>
          <span className="size-4" />
          <span>Row</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem
            onSelect={() => run(() => tf.insert.tableRow({ before: true }))}
          >
            <ArrowUp />
            Insert row before
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.insert.tableRow())}>
            <ArrowDown />
            Insert row after
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.remove.tableRow())}>
            <X />
            Delete row
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!tableSelected}>
          <span className="size-4" />
          <span>Column</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-52">
          <DropdownMenuItem
            onSelect={() => run(() => tf.insert.tableColumn({ before: true }))}
          >
            <ArrowLeft />
            Insert column before
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.insert.tableColumn())}>
            <ArrowRight />
            Insert column after
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.remove.tableColumn())}>
            <X />
            Delete column
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuItem
        disabled={!tableSelected}
        onSelect={() => run(() => tf.remove.table())}
      >
        <Trash2 />
        Delete table
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

function TablePicker({
  onInsert,
}: {
  onInsert: (rowCount: number, colCount: number) => void;
}) {
  const [size, setSize] = useState({ colCount: 3, rowCount: 3 });
  const dimension = 8;

  return (
    <div
      aria-label={`Insert ${size.rowCount} by ${size.colCount} table`}
      className="m-0 flex flex-col gap-1 p-1 outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onInsert(size.rowCount, size.colCount);
          return;
        }

        const next = { ...size };
        if (event.key === 'ArrowUp')
          next.rowCount = Math.max(1, size.rowCount - 1);
        else if (event.key === 'ArrowDown')
          next.rowCount = Math.min(dimension, size.rowCount + 1);
        else if (event.key === 'ArrowLeft')
          next.colCount = Math.max(1, size.colCount - 1);
        else if (event.key === 'ArrowRight')
          next.colCount = Math.min(dimension, size.colCount + 1);
        else return;

        event.preventDefault();
        setSize(next);
      }}
      role="grid"
      tabIndex={0}
    >
      <div className="grid size-32 grid-cols-8 gap-0.5">
        {Array.from({ length: dimension * dimension }, (_, index) => {
          const row = Math.floor(index / dimension) + 1;
          const column = (index % dimension) + 1;
          const active = row <= size.rowCount && column <= size.colCount;

          return (
            <button
              aria-label={`Insert ${row} by ${column} table`}
              aria-selected={active}
              className={cn(
                'size-3.5 rounded-xs border border-line bg-surface outline-none',
                active && 'border-action-accent bg-tint-accent-1'
              )}
              key={`${row}:${column}`}
              onClick={() => onInsert(row, column)}
              onFocus={() => setSize({ colCount: column, rowCount: row })}
              onPointerEnter={() =>
                setSize({ colCount: column, rowCount: row })
              }
              role="gridcell"
              tabIndex={-1}
              type="button"
            />
          );
        })}
      </div>
      <div className="text-center text-fg-secondary text-xs">
        {size.rowCount} × {size.colCount}
      </div>
    </div>
  );
}
