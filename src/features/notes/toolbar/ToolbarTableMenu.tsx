import { TablePlugin, useTableMergeState } from '@platejs/table/react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';
import { useState } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { ToolbarPopoverButton } from '@/components/ui/ToolbarPopover';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { TablePicker } from './TablePicker';
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
        <ToolbarPopoverButton
          disabled={disabled}
          size="sm"
          type="button"
          variant="ghost-hover"
        >
          {trigger}
        </ToolbarPopoverButton>
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
