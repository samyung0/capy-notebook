import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/Dialog';
import { m } from '@/i18n';
import { CellText, ColumnLabel } from './cells';
import { useTableView } from './context';
import { EditableCell, type Editing } from './EditableTable';
import { deleteRow, setCell } from './edit';
import { CommitInput, textCell } from './fields';
import { cellValue, drawnColumns, TABLE_VIEW_LIMITS } from './model';

/** A record with every field (mock Kanban: "A card opens the record"): its
 * title as a large field, each other column a labelled row with the table's
 * editors, and Delete record. Read-only in a read-only note. Phones get the
 * app's full-screen dialog page. Closes when the record is gone. */
export function RecordDialog({
  focusTitle,
  onClose,
  rowId,
}: {
  /** A new record: the title takes the focus. */
  focusTitle: boolean;
  onClose: () => void;
  rowId: string;
}) {
  const { block, write } = useTableView();
  const [editing, setEditing] = useState<Editing>(null);
  const row = block.rows.find(({ id }) => id === rowId);
  if (!row) return null;
  const [title, ...fields] = drawnColumns(block);
  const name = cellValue(title, row);
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="sm:max-w-xl"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          if (focusTitle && write) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogTitle className="pb-4 sm:pr-10">
          {write ? (
            <CommitInput
              aria-label={title.name}
              autoFocus={focusTitle}
              className="w-full font-semibold text-2xl leading-tight max-sm:text-lg"
              maxLength={TABLE_VIEW_LIMITS.cell}
              onCommit={(text) =>
                write((current) =>
                  setCell(current, row.id, title.id, textCell(text))
                )
              }
              placeholder={m.table_view_untitled()}
              value={name === undefined ? '' : String(name)}
            />
          ) : (
            <span className="w-full font-semibold text-2xl leading-tight max-sm:text-lg">
              {name || m.table_view_untitled()}
            </span>
          )}
        </DialogTitle>
        <dl className="flex flex-col border-line border-t text-sm">
          {fields.map((column) => (
            <div
              className="grid min-h-10 grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-2 border-line border-b"
              key={column.id}
            >
              <dt className="min-w-0 text-fg-muted">
                <ColumnLabel column={column} />
              </dt>
              <dd className="min-w-0">
                {write ? (
                  <EditableCell
                    className="rounded-button"
                    column={column}
                    editing={editing?.columnId === column.id}
                    onEdit={setEditing}
                    row={row}
                    write={write}
                  />
                ) : (
                  <div className="flex h-9 min-w-0 items-center px-2.5">
                    <CellText column={column} row={row} />
                  </div>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {write && (
          <Button
            className="mt-5 self-start"
            iconLeft="trash"
            onClick={() => {
              write((current) => deleteRow(current, row.id));
              onClose();
            }}
            size="sm"
            variant="danger"
          >
            {m.table_view_delete_record()}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
