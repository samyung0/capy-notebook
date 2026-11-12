import type { TElement } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useReadOnly,
} from 'platejs/react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  keepKeys,
  TableViewContext,
  type TableViewEdit,
  useTableView,
} from './context';
import { EditableTable, type Editing } from './EditableTable';
import {
  addRow,
  addView,
  canAddRow,
  canAddView,
  deleteView,
  renameView,
  setGroupBy,
  setSort,
  setTitle,
  titleColumn,
  uniqueName,
} from './edit';
import { CommitInput } from './fields';
import { COLUMN_ICON, VIEW_ICON, VIEW_KIND_LABEL } from './look';
import {
  type CellValue,
  drawnColumns,
  groupColumn,
  isTableViewBlock,
  TABLE_VIEW_LIMITS,
  type TableViewElement as TableViewNode,
  type TableViewView,
  VIEW_KINDS,
} from './model';
import { TableViewKanban } from './TableViewKanban';

const TOOL =
  'h-7 gap-1.5 px-2 font-normal text-fg-muted data-[state=open]:bg-surface-hover-bg data-[state=open]:text-fg';

/** A view's tab; the open one's menu renames or deletes it (never the last
 * view). Narrow screens show the other views as their icons. */
function ViewTab({
  active,
  onOpen,
  view,
}: {
  active: boolean;
  onOpen: () => void;
  view: TableViewView;
}) {
  const { block, write } = useTableView();
  const [name, setName] = useState(view.name);
  const tab = (
    <>
      <Icon className="shrink-0" name={VIEW_ICON[view.kind]} />
      <span className={cn('truncate', !active && 'hidden sm:inline')}>
        {view.name}
      </span>
    </>
  );
  const className = cn(
    'inline-flex h-7 min-w-0 max-w-48 shrink-0 items-center gap-1.5 rounded-button px-2 outline-none focus-visible:ring-2 focus-visible:ring-action',
    active
      ? 'bg-surface-hover-bg font-semibold text-fg'
      : 'text-fg-muted hover:bg-surface-hover-bg/60 hover:text-fg'
  );
  if (!(active && write))
    return (
      <button
        aria-label={view.name}
        aria-selected={active}
        className={className}
        onClick={onOpen}
        role="tab"
        type="button"
      >
        {tab}
      </button>
    );
  const rename = () => {
    const next = name.trim();
    if (next && next !== view.name)
      write((current) => renameView(current, view.id, next));
  };
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => (open ? setName(view.name) : rename())}
    >
      <DropdownMenuTrigger
        aria-label={view.name}
        aria-selected
        className={className}
        role="tab"
      >
        {tab}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-56"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="p-1 pb-1.5">
          <Input
            aria-label={m.table_view_view_name()}
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
        <DropdownMenuItem
          className="text-tint-error-fg"
          disabled={block.views.length <= 1}
          onSelect={() => write((current) => deleteView(current, view.id))}
        >
          <Icon name="trash" />
          {m.table_view_delete_view()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddView({ onAdded }: { onAdded: (viewId: string) => void }) {
  const { block, write } = useTableView();
  if (!write) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={m.table_view_add_view()}
        className="flex size-7 shrink-0 items-center justify-center rounded-button text-fg-muted outline-none hover:bg-surface-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-action disabled:opacity-40"
        disabled={!canAddView(block)}
        title={m.table_view_add_view()}
      >
        <Icon name="plus" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-44"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {VIEW_KINDS.map((kind) => (
          <DropdownMenuItem
            key={kind}
            onSelect={() => {
              let viewId = '';
              write((current) => {
                const added = addView(
                  current,
                  kind,
                  uniqueName(
                    VIEW_KIND_LABEL[kind](),
                    current.views.map(({ name }) => name)
                  )
                );
                viewId = added.viewId;
                return added.block;
              });
              onAdded(viewId);
            }}
          >
            <Icon name={VIEW_ICON[kind]} />
            {VIEW_KIND_LABEL[kind]()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The view's sort: a column and a direction (mock Main: the sorted
 * column's name beside the icon). */
function SortControl({ view }: { view: TableViewView }) {
  const { block, write } = useTableView();
  if (!write) return null;
  const columns = drawnColumns(block);
  const sorted = columns.find(({ id }) => id === view.sort?.columnId);
  const dir = view.sort?.dir ?? 'asc';
  const sort = (columnId: string, next: 'asc' | 'desc') =>
    write((current) => setSort(current, view.id, { columnId, dir: next }));
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={m.table_view_sort()}
          className={cn(TOOL, 'max-sm:size-8 max-sm:px-0')}
          size="xs"
          variant="ghost-hover"
        >
          <Icon name="sort" />
          <span className="hidden max-w-32 truncate sm:inline">
            {sorted?.name ?? m.table_view_sort()}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {columns.map((column) => (
          <DropdownMenuItem
            key={column.id}
            onSelect={() => sort(column.id, dir)}
          >
            <Icon name={COLUMN_ICON[column.kind]} />
            <span className="truncate">{column.name}</span>
            {column === sorted && <Icon className="ml-auto" name="check" />}
          </DropdownMenuItem>
        ))}
        {sorted && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => sort(sorted.id, 'asc')}>
              <Icon name="arrowUp" />
              {m.table_view_sort_asc()}
              {dir === 'asc' && <Icon className="ml-auto" name="check" />}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => sort(sorted.id, 'desc')}>
              <Icon name="arrowDown" />
              {m.table_view_sort_desc()}
              {dir === 'desc' && <Icon className="ml-auto" name="check" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                write((current) => setSort(current, view.id, undefined))
              }
            >
              <Icon name="x" />
              {m.table_view_sort_remove()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A Kanban view's Select column (mock Kanban "Group by Status"). */
function GroupByControl({ view }: { view: TableViewView }) {
  const { block, write } = useTableView();
  if (!write) return null;
  const group = groupColumn(block, view);
  const selects = drawnColumns(block).filter(({ kind }) => kind === 'select');
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button className={TOOL} size="xs" variant="ghost-hover">
          <span className="max-w-40 truncate">
            {group
              ? m.table_view_group_by_column({ name: group.name })
              : m.table_view_group_by()}
          </span>
          <Icon name="chevronDown" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel>{m.table_view_group_by()}</DropdownMenuLabel>
        {selects.length === 0 && (
          <p className="px-2.5 py-1.5 text-fg-muted text-sm">
            {m.table_view_no_group_column()}
          </p>
        )}
        {selects.map((column) => (
          <DropdownMenuItem
            key={column.id}
            onSelect={() =>
              write((current) => setGroupBy(current, view.id, column.id))
            }
          >
            <Icon name={COLUMN_ICON.select} />
            <span className="truncate">{column.name}</span>
            {column === group && <Icon className="ml-auto" name="check" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Drawn when merges left no view: a plain table. */
const NO_VIEW: TableViewView = { id: '', kind: 'table', name: '' };

/** The block (mock Main): its title, the view tabs with + and the view's
 * controls, then the open view. Which view is open is each reader's own. */
function TableViewBody() {
  const { block, write } = useTableView();
  const [viewId, setViewId] = useState(block.views[0]?.id);
  const [editing, setEditing] = useState<Editing>(null);
  const onEdit = useCallback((next: Editing) => setEditing(next), []);
  const view =
    block.views.find(({ id }) => id === viewId) ?? block.views[0] ?? NO_VIEW;
  const newRecord = (cells: Record<string, CellValue> = {}) => {
    let rowId = '';
    write?.((current) => {
      const added = addRow(current, cells);
      rowId = added.rowId;
      return added.block;
    });
    if (rowId) setEditing({ columnId: titleColumn(block).id, rowId });
  };
  const kanban = view.kind === 'kanban';
  // A Kanban's New record lands in its first column.
  const group = kanban ? groupColumn(block, view) : undefined;
  const first = group?.options?.[0];
  return (
    <section aria-label={block.title || m.editor_table_view()}>
      {write ? (
        <CommitInput
          aria-label={m.table_view_title()}
          className="block h-8 w-full font-semibold text-lg"
          maxLength={TABLE_VIEW_LIMITS.name}
          onCommit={(title) => write((current) => setTitle(current, title))}
          placeholder={m.table_view_untitled()}
          value={block.title}
        />
      ) : (
        block.title.trim() && (
          <div className="flex h-8 items-center font-semibold text-lg">
            {block.title}
          </div>
        )
      )}
      <div className="mt-1.5 flex h-9 items-center gap-1 border-line border-b text-sm">
        <div
          aria-label={m.table_view_views()}
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
          role="tablist"
        >
          {block.views.map((item) => (
            <ViewTab
              active={item === view}
              key={item.id}
              onOpen={() => setViewId(item.id)}
              view={item}
            />
          ))}
        </div>
        <AddView onAdded={setViewId} />
        {write && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {kanban ? (
              <GroupByControl view={view} />
            ) : (
              <SortControl view={view} />
            )}
            <Button
              className="h-8 gap-1 px-2.5 sm:h-7"
              disabled={!canAddRow(block)}
              iconLeft="plus"
              onClick={() =>
                newRecord(group && first ? { [group.id]: first.id } : {})
              }
              size="xs"
              variant="outline"
            >
              <span className="sm:hidden">{m.table_view_new()}</span>
              <span className="hidden sm:inline">
                {m.table_view_new_record()}
              </span>
            </Button>
          </div>
        )}
      </div>
      {kanban ? (
        <TableViewKanban
          editing={editing}
          onEdit={onEdit}
          onNewRecord={newRecord}
          view={view}
        />
      ) : (
        <EditableTable
          editing={editing}
          onEdit={onEdit}
          onNewRecord={() => newRecord()}
          view={view}
        />
      )}
    </section>
  );
}

/** The note's table view block (Epo 2026-11-12): a top-level void whose
 * block is a live map in the room. Every edit writes the whole block with
 * `setNodes`, as a figure dialog's save does; the room's map then rewrites
 * only the columns, rows and views that changed, so peers' edits to other
 * entries merge. A read-only note draws it with its tabs and nothing else. */
export function TableViewElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const element = props.element as unknown as TableViewNode;
  const { block, id } = element;
  const write = useCallback(
    (edit: TableViewEdit) => {
      const at = editor.children.findIndex((node) => node.id === id);
      if (at < 0) return;
      const current = (editor.children[at] as unknown as TableViewNode).block;
      const next = edit(current);
      if (next === current) return;
      // A merge can leave a block past a cap; edits never take one there.
      if (isTableViewBlock(current) && !isTableViewBlock(next))
        throw new Error('A table view edit broke the block rules.');
      editor.tf.setNodes({ block: next } as Partial<TElement>, { at: [at] });
    },
    [editor, id]
  );
  const api = useMemo(
    () => ({ block, write: readOnly ? undefined : write }),
    [block, readOnly, write]
  );
  return (
    <PlateElement {...props} className="relative my-3">
      <div
        contentEditable={false}
        onMouseDown={(event) => {
          // A press outside its fields selects the block, as a figure's does.
          if (
            readOnly ||
            (event.target as Element).closest(
              'input, button, [role="dialog"], [role="menu"]'
            )
          )
            return;
          event.preventDefault();
          const at = editor.api.findPath(props.element);
          if (at) {
            editor.tf.select(editor.api.start(at));
            editor.tf.focus();
          }
        }}
      >
        <TableViewContext.Provider value={api}>
          <TableViewBody />
        </TableViewContext.Provider>
      </div>
      {/* Slate's void spacer, positioned like a figure's (blocks/elements). */}
      <span className="absolute top-0 left-0">{props.children}</span>
    </PlateElement>
  );
}
