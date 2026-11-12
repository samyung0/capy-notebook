import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useTableView } from './context';
import type { Editing } from './EditableTable';
import {
  canAddRow,
  type KanbanGroup,
  kanbanGroups,
  moveCard,
  setCell,
} from './edit';
import { CommitInput, OptionChip, textCell } from './fields';
import { formatDate } from './look';
import {
  cellOption,
  cellValue,
  drawnColumns,
  groupColumn,
  TABLE_VIEW_LIMITS,
  type TableViewColumn,
  type TableViewRow,
  type TableViewView,
} from './model';

/** A card's drag data: its record's id, under a type of its own so neither
 * the note's block drag nor its text drop reads it. */
const CARD_TYPE = 'application/x-capy-table-view-record';

/** A card's other fields, after its title, as one muted line: each filled
 * field once, dates and numbers with their column's name. */
function cardFields(
  columns: TableViewColumn[],
  group: TableViewColumn,
  row: TableViewRow
): string[] {
  const out: string[] = [];
  for (const column of columns) {
    if (column.kind === 'title' || column.id === group.id) continue;
    const value = cellValue(column, row);
    if (value === undefined || value === '' || value === false) continue;
    if (column.kind === 'select') {
      const option = cellOption(column, row);
      if (option) out.push(option.name);
    } else if (column.kind === 'date')
      out.push(`${column.name} ${formatDate(value as string)}`);
    else if (column.kind === 'number') out.push(`${column.name} ${value}`);
    else if (column.kind === 'checkbox') out.push(`✓ ${column.name}`);
    else out.push(String(value));
  }
  return out;
}

type CardEditing = {
  editing: Editing;
  onEdit: (editing: Editing) => void;
};

function Card({
  columns,
  editing: open,
  group,
  onEdit,
  row,
}: CardEditing & {
  columns: TableViewColumn[];
  group: TableViewColumn;
  row: TableViewRow;
}) {
  const { write } = useTableView();
  const title = columns[0];
  const editing = open?.rowId === row.id && open.columnId === title.id;
  const name = cellValue(title, row);
  const fields = cardFields(columns, group, row);
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm',
        write && 'cursor-grab active:cursor-grabbing'
      )}
      draggable={!!write && !editing}
      onDragStart={(event) => {
        // The note's own drop would read the card as a dragged block.
        event.stopPropagation();
        event.dataTransfer.setData(CARD_TYPE, row.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      {editing && write ? (
        <CommitInput
          aria-label={title.name}
          autoFocus
          className="font-semibold"
          maxLength={TABLE_VIEW_LIMITS.cell}
          onCommit={(text) =>
            write((block) => setCell(block, row.id, title.id, textCell(text)))
          }
          onDone={() => onEdit(null)}
          value={name === undefined ? '' : String(name)}
        />
      ) : (
        <button
          className={cn(
            'min-w-0 text-left font-semibold outline-none focus-visible:underline',
            !name && 'text-fg-muted',
            !write && 'cursor-default'
          )}
          disabled={!write}
          onClick={() => onEdit({ columnId: title.id, rowId: row.id })}
          type="button"
        >
          {name || m.table_view_untitled()}
        </button>
      )}
      {fields.length > 0 && (
        <span className="text-[13px] text-fg-muted">{fields.join(' · ')}</span>
      )}
    </div>
  );
}

function Lane({
  columns,
  editing,
  group,
  lane,
  onEdit,
  onNewRecord,
}: CardEditing & {
  /** A record added with `cells`, its title open. */
  onNewRecord: (cells: Record<string, string>) => void;
  columns: TableViewColumn[];
  group: TableViewColumn;
  lane: KanbanGroup;
}) {
  const { block, write } = useTableView();
  const [over, setOver] = useState(false);
  const accepts = (event: React.DragEvent) =>
    !!write && event.dataTransfer.types.includes(CARD_TYPE);
  return (
    <section
      aria-label={
        lane.option?.name ?? m.table_view_no_option({ name: group.name })
      }
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg p-1 transition-colors',
        over && 'bg-surface-hover-bg'
      )}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOver(false);
      }}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDrop={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const rowId = event.dataTransfer.getData(CARD_TYPE);
        write?.((next) => moveCard(next, rowId, group.id, lane.option?.id));
      }}
    >
      <div className="flex h-6 items-center gap-2 text-sm">
        {lane.option ? (
          <OptionChip option={lane.option} />
        ) : (
          <span className="text-fg-muted">
            {m.table_view_no_option({ name: group.name })}
          </span>
        )}
        <span className="text-[13px] text-fg-muted">{lane.rows.length}</span>
      </div>
      {lane.rows.map((row) => (
        <Card
          columns={columns}
          editing={editing}
          group={group}
          key={row.id}
          onEdit={onEdit}
          row={row}
        />
      ))}
      {write && (
        <button
          className="flex h-8 items-center gap-1.5 rounded-button px-1 text-fg-muted text-sm outline-none hover:bg-surface-hover-bg hover:text-fg focus-visible:bg-surface-hover-bg disabled:opacity-40"
          disabled={!canAddRow(block)}
          onClick={() =>
            onNewRecord(lane.option ? { [group.id]: lane.option.id } : {})
          }
          type="button"
        >
          <Icon name="plus" />
          {m.table_view_new()}
        </button>
      )}
    </section>
  );
}

/** The Kanban view (mock Kanban): a column per option of its Select column,
 * cards with the title and the other filled fields; a card dropped on
 * another column takes its option. */
export function TableViewKanban({
  editing,
  onEdit,
  onNewRecord,
  view,
}: CardEditing & {
  onNewRecord: (cells: Record<string, string>) => void;
  view: TableViewView;
}) {
  const { block } = useTableView();
  const group = groupColumn(block, view);
  if (!group)
    return (
      <p className="py-6 text-center text-fg-muted text-sm">
        {m.table_view_no_group_column()}
      </p>
    );
  const columns = drawnColumns(block);
  const lanes = kanbanGroups(block, view);
  return (
    <div className="mt-3.5 grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1">
      {lanes.map((lane) => (
        <Lane
          columns={columns}
          editing={editing}
          group={group}
          key={lane.option?.id ?? ''}
          lane={lane}
          onEdit={onEdit}
          onNewRecord={onNewRecord}
        />
      ))}
    </div>
  );
}
