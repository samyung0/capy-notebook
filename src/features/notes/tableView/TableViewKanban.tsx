import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { OptionChip } from './cells';
import { useTableView } from './context';
import { tableViewDate } from './display';
import { canAddRow, type KanbanGroup, kanbanGroups, moveCard } from './edit';
import {
  cellOption,
  cellValue,
  drawnColumns,
  groupColumn,
  plainNumber,
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
      out.push(`${column.name} ${tableViewDate(value as string)}`);
    else if (column.kind === 'number')
      out.push(`${column.name} ${plainNumber(value as number)}`);
    else if (column.kind === 'checkbox') out.push(`✓ ${column.name}`);
    else out.push(String(value));
  }
  return out;
}

type CardOpen = {
  /** Opens a record with every field. */
  onOpen: (rowId: string) => void;
};

/** A record's card: its title and other filled fields. A click opens the
 * record; in an editable note a drag moves it to another column. */
function Card({
  columns,
  group,
  onOpen,
  row,
}: CardOpen & {
  columns: TableViewColumn[];
  group: TableViewColumn;
  row: TableViewRow;
}) {
  const { write } = useTableView();
  const name = cellValue(columns[0], row);
  const fields = cardFields(columns, group, row);
  return (
    <div
      className={cn(
        'flex cursor-pointer flex-col gap-1 rounded-lg border border-line bg-surface px-3 py-2.5 text-left text-sm outline-none hover:bg-surface-hover-bg/40 focus-visible:ring-2 focus-visible:ring-action',
        write && 'active:cursor-grabbing'
      )}
      draggable={!!write}
      onClick={() => onOpen(row.id)}
      onDragStart={(event) => {
        // The note's own drop would read the card as a dragged block.
        event.stopPropagation();
        event.dataTransfer.setData(CARD_TYPE, row.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(row.id);
      }}
      role="button"
      tabIndex={0}
    >
      <span className={cn('min-w-0 font-semibold', !name && 'text-fg-muted')}>
        {name || m.table_view_untitled()}
      </span>
      {fields.length > 0 && (
        <span className="text-[13px] text-fg-muted">{fields.join(' · ')}</span>
      )}
    </div>
  );
}

function Lane({
  columns,
  group,
  lane,
  onNewRecord,
  onOpen,
}: CardOpen & {
  /** A record added with `cells`, opened. */
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
          group={group}
          key={row.id}
          onOpen={onOpen}
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
  onNewRecord,
  onOpen,
  view,
}: CardOpen & {
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
          group={group}
          key={lane.option?.id ?? ''}
          lane={lane}
          onNewRecord={onNewRecord}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
