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
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export function TableMenu() {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <span className="inline-flex">
          <ToolbarButton active={open} label={m.editor_table_controls()}>
            <Table2 />
          </ToolbarButton>
        </span>
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
          <span>{m.editor_table()}</span>
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
          <span>{m.editor_cell()}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem
            disabled={!canMerge}
            onSelect={() => run(() => tf.table.merge())}
          >
            <Combine />
            {m.editor_merge_cells()}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canSplit}
            onSelect={() => run(() => tf.table.split())}
          >
            <Ungroup />
            {m.editor_split_cell()}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!tableSelected}>
          <span className="size-4" />
          <span>{m.editor_row()}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem
            onSelect={() => run(() => tf.insert.tableRow({ before: true }))}
          >
            <ArrowUp />
            {m.editor_insert_row_before()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.insert.tableRow())}>
            <ArrowDown />
            {m.editor_insert_row_after()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.remove.tableRow())}>
            <X />
            {m.editor_delete_row()}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!tableSelected}>
          <span className="size-4" />
          <span>{m.editor_column()}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-52">
          <DropdownMenuItem
            onSelect={() => run(() => tf.insert.tableColumn({ before: true }))}
          >
            <ArrowLeft />
            {m.editor_insert_col_before()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.insert.tableColumn())}>
            <ArrowRight />
            {m.editor_insert_col_after()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => tf.remove.tableColumn())}>
            <X />
            {m.editor_delete_col()}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuItem
        disabled={!tableSelected}
        onSelect={() => run(() => tf.remove.table())}
      >
        <Trash2 />
        {m.editor_delete_table()}
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
      aria-label={m.editor_insert_table_size({
        cols: String(size.colCount),
        rows: String(size.rowCount),
      })}
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
              aria-label={m.editor_insert_table_size({
                cols: String(column),
                rows: String(row),
              })}
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
