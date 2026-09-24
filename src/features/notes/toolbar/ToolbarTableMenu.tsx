import { TablePlugin, useTableMergeState } from '@platejs/table/react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { ToolbarPopoverContent, ToolbarPopoverRow } from './ToolbarPopover';

export function TableMenu() {
  const [open, setOpen] = useState(false);
  const tableSelected = useEditorSelector(
    (editor) => editor.api.some({ match: { type: KEYS.table } }),
    []
  );

  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <ToolbarButton active={tableSelected} label={m.editor_table_controls()}>
          <EditorIcon name="table" />
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="start"
        className="w-45 gap-0 p-1"
        open={open}
      >
        <TableMenuItems onClose={() => setOpen(false)} open={open} />
      </ToolbarPopoverContent>
    </Popover>
  );
}

/**
 * Split out so the document subscriptions live under `ToolbarPopoverContent`,
 * which Radix does not render while the menu is closed. `useTableMergeState`
 * reads the selected cells through `useEditorSelector` with reference equality
 * over a freshly built array, so it reports a change on every edit; reading it
 * from the always-mounted toolbar button re-rendered this entire menu on every
 * keystroke, open or not.
 */
function TableMenuItems({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { editor, tf } = useEditorPlugin(TablePlugin);
  const tableSelected = useEditorSelector(
    (currentEditor) => currentEditor.api.some({ match: { type: KEYS.table } }),
    []
  );
  const { canMerge, canSplit } = useTableMergeState();

  const run = (action: () => void) => {
    action();
    onClose();
    editor.tf.focus();
  };

  return (
    <>
      <TablePopoverGroup
        className="w-auto p-0"
        parentOpen={open}
        trigger={
          <>
            <EditorIcon name="grid" />
            <span>{m.editor_table()}</span>
          </>
        }
      >
        <TablePicker
          onInsert={(rowCount, colCount) => {
            run(() =>
              tf.insert.table({ colCount, rowCount }, { select: true })
            );
          }}
        />
      </TablePopoverGroup>

      <TablePopoverGroup
        className="w-48"
        disabled={!tableSelected}
        parentOpen={open}
        trigger={
          <>
            <span className="size-4" />
            <span>{m.editor_cell()}</span>
          </>
        }
      >
        <ToolbarPopoverRow
          disabled={!canMerge}
          icon={<EditorIcon name="combine" />}
          label={m.editor_merge_cells()}
          onClick={() => run(() => tf.table.merge())}
        />
        <ToolbarPopoverRow
          disabled={!canSplit}
          icon={<EditorIcon name="ungroup" />}
          label={m.editor_split_cell()}
          onClick={() => run(() => tf.table.split())}
        />
      </TablePopoverGroup>

      <TablePopoverGroup
        className="w-48"
        disabled={!tableSelected}
        parentOpen={open}
        trigger={
          <>
            <span className="size-4" />
            <span>{m.editor_row()}</span>
          </>
        }
      >
        <ToolbarPopoverRow
          icon={<EditorIcon name="arrowUp" />}
          label={m.editor_insert_row_before()}
          onClick={() => run(() => tf.insert.tableRow({ before: true }))}
        />
        <ToolbarPopoverRow
          icon={<EditorIcon name="arrowDown" />}
          label={m.editor_insert_row_after()}
          onClick={() => run(() => tf.insert.tableRow())}
        />
        <ToolbarPopoverRow
          icon={<EditorIcon name="x" />}
          label={m.editor_delete_row()}
          onClick={() => run(() => tf.remove.tableRow())}
        />
      </TablePopoverGroup>

      <TablePopoverGroup
        className="w-52"
        disabled={!tableSelected}
        parentOpen={open}
        trigger={
          <>
            <span className="size-4" />
            <span>{m.editor_column()}</span>
          </>
        }
      >
        <ToolbarPopoverRow
          icon={<EditorIcon name="arrowLeft" />}
          label={m.editor_insert_col_before()}
          onClick={() => run(() => tf.insert.tableColumn({ before: true }))}
        />
        <ToolbarPopoverRow
          icon={<EditorIcon name="arrowRight" />}
          label={m.editor_insert_col_after()}
          onClick={() => run(() => tf.insert.tableColumn())}
        />
        <ToolbarPopoverRow
          icon={<EditorIcon name="x" />}
          label={m.editor_delete_col()}
          onClick={() => run(() => tf.remove.tableColumn())}
        />
      </TablePopoverGroup>

      <ToolbarPopoverRow
        disabled={!tableSelected}
        icon={<EditorIcon name="trash" />}
        label={m.editor_delete_table()}
        onClick={() => run(() => tf.remove.table())}
      />
    </>
  );
}

function TablePopoverGroup({
  parentOpen,
  trigger,
  children,
  disabled,
  className,
}: {
  parentOpen: boolean;
  trigger: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={parentOpen && open}>
      <PopoverTrigger asChild>
        <Button
          className="h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal [&_svg]:size-4"
          disabled={disabled}
          size="sm"
          type="button"
          variant="ghost-hover"
        >
          {trigger}
        </Button>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="start"
        className={cn('gap-0 p-1', className)}
        open={parentOpen && open}
        side="right"
      >
        {children}
      </ToolbarPopoverContent>
    </Popover>
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
