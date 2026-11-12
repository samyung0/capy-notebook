import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { ColumnLabel } from './cells';
import { keepKeys, useTableView } from './context';
import { COLUMN_ICON } from './display';
import {
  canAddColumn,
  deleteColumn,
  duplicateColumn,
  insertColumn,
  newColumn,
  renameColumn,
  retypeColumn,
  setSort,
  uniqueName,
} from './edit';
import { COLUMN_KIND_LABEL } from './look';
import {
  COLUMN_KINDS,
  TABLE_VIEW_LIMITS,
  type TableViewColumn,
  type TableViewView,
} from './model';

/** A click on a column's name opens this (mock ColumnMenu): its name, its
 * type, the view's sort on it, insert, duplicate and delete. The title column
 * is renamed only, never retyped or deleted. */
export function ColumnMenu({
  className,
  column,
  view,
}: {
  className?: string;
  column: TableViewColumn;
  view: TableViewView;
}) {
  const { block, write } = useTableView();
  const [name, setName] = useState(column.name);
  const [open, setOpen] = useState(false);
  if (!write) return <ColumnLabel column={column} />;
  const title = column.kind === 'title';
  const room = canAddColumn(block);
  const rename = () => {
    if (name !== column.name)
      write((next) => renameColumn(next, column.id, name));
  };
  const insert = (side: 'left' | 'right') =>
    write((next) =>
      insertColumn(
        next,
        newColumn(
          uniqueName(
            m.table_view_column(),
            next.columns.map((item) => item.name)
          )
        ),
        { columnId: column.id, side }
      )
    );
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(next) => {
        if (next) setName(column.name);
        else rename();
        setOpen(next);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        className={cn(
          'flex size-full min-w-0 items-center px-2.5 outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg data-[state=open]:bg-surface-hover-bg data-[state=open]:text-fg',
          className
        )}
      >
        <ColumnLabel column={column} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-62"
        data-plate-prevent-deselect
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <label className="block px-1 pt-1 pb-1.5">
          <span className="mb-1 ml-1 block text-fg-muted text-xs">
            {m.table_view_column_name()}
          </span>
          <Input
            aria-label={m.table_view_column_name()}
            maxLength={TABLE_VIEW_LIMITS.name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              keepKeys(event);
              if (event.key === 'Enter') {
                rename();
                setOpen(false);
              }
            }}
            size="sm"
            value={name}
            wrapperClassName="h-8"
          />
        </label>
        {!title && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Icon name={COLUMN_ICON[column.kind]} />
              {m.table_view_type()}
              <span className="ml-auto text-fg-muted">
                {COLUMN_KIND_LABEL[column.kind]()}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className="w-48"
              data-plate-prevent-deselect
            >
              {COLUMN_KINDS.filter((kind) => kind !== 'title').map((kind) => (
                <DropdownMenuItem
                  key={kind}
                  onSelect={() =>
                    write((next) => retypeColumn(next, column.id, kind))
                  }
                >
                  <Icon name={COLUMN_ICON[kind]} />
                  {COLUMN_KIND_LABEL[kind]()}
                  {kind === column.kind && (
                    <Icon className="ml-auto" name="check" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem
          onSelect={() =>
            write((next) =>
              setSort(next, view.id, { columnId: column.id, dir: 'asc' })
            )
          }
        >
          <Icon name="arrowUp" />
          {m.table_view_sort_asc()}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            write((next) =>
              setSort(next, view.id, { columnId: column.id, dir: 'desc' })
            )
          }
        >
          <Icon name="arrowDown" />
          {m.table_view_sort_desc()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {!title && (
          <DropdownMenuItem disabled={!room} onSelect={() => insert('left')}>
            <Icon name="insertColumnLeft" />
            {m.table_view_insert_left()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!room} onSelect={() => insert('right')}>
          <Icon name="insertColumnRight" />
          {m.table_view_insert_right()}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!room}
          onSelect={() => write((next) => duplicateColumn(next, column.id))}
        >
          <Icon name="clone" />
          {m.editor_duplicate()}
        </DropdownMenuItem>
        {!title && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-tint-error-fg"
              onSelect={() => write((next) => deleteColumn(next, column.id))}
            >
              <Icon name="trash" />
              {m.table_view_delete_column()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
