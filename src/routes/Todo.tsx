import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTodo, useTodoDone } from '@/api/hooks';
import { InlineErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { ListToolbar, toggleValue } from '@/components/app/ListToolbar';
import { PageBody, PageHeader, PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import type { ColumnSort } from '@/components/app/SortHeader';
import { SkeletonList } from '@/components/ui/feedback';
import { Tabs } from '@/components/ui/Tabs';
import { SelectionAction, SelectionBar } from '@/features/files/SelectionBar';
import {
  TodoTable,
  useTodoTicks,
} from '@/features/study/assignments/TodoTable';
import {
  doneSections,
  todoCount,
  todoSections,
} from '@/features/study/assignments/todoRows';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import {
  commaList,
  csv,
  TODO_TYPES,
  type TodoSearch,
  type TodoSort,
  type TodoType,
} from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';

/** Due and To do read ascending first; Done's date newest first. */
const ascendsFirst = (sort: TodoSort) => sort !== 'done';

/** To do (Epo 2026-11-08; the table, 2026-11-10 board K): tabs To do · Done,
 * a Type filter, then a table grouped by class whose Due and To do headers
 * sort it. Selected rows turn the toolbar into a selection bar with Mark as
 * done and Mark as not done (Epo 2026-11-10), and Delete on Done. Approvals
 * stay in the To do tab; Done reads its own list, closed work included. The
 * table takes the page's full width (Epo 2026-11-10). */
export default function Todo() {
  const search = useSearch({ from: '/auth-shell/todo' });
  const tab = search.tab ?? 'todo';
  const onDone = tab === 'done';
  const {
    data: todo,
    error: todoError,
    fetchStatus: todoFetch,
    isLoading: todoLoading,
    refetch: todoRefetch,
  } = useTodo({ errorBoundary: false });
  const navigate = useNavigate({ from: '/todo' });
  const setSearch = (patch: TodoSearch) =>
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) });

  const sort: TodoSort = onDone
    ? 'done'
    : search.sort === 'title'
      ? 'title'
      : 'due';
  const ascending = search.dir ? search.dir === 'asc' : ascendsFirst(sort);
  const sorting: ColumnSort<TodoSort> = {
    ascending,
    ascendingFirst: ['due', 'title'],
    onSortChange: (next, asc) =>
      setSearch({
        dir: asc === ascendsFirst(next) ? undefined : asc ? 'asc' : 'desc',
        sort: next === 'due' || next === 'done' ? undefined : next,
      }),
    sort,
  };
  const types = commaList(search.type) as TodoType[];
  // Done is paged, sorted and filtered by the server (Epo 2026-11-08).
  const {
    data: done,
    error: doneError,
    fetchNextPage,
    fetchStatus: doneFetch,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isLoading: doneLoading,
    refetch: doneRefetch,
  } = useTodoDone(
    { dir: onDone && ascending ? 'asc' : undefined, type: types },
    onDone
  );
  const data = onDone ? done : todo;
  const error = onDone ? doneError : todoError;
  const fetchStatus = onDone ? doneFetch : todoFetch;
  const isLoading = onDone ? doneLoading : todoLoading;
  const refetch = onDone ? doneRefetch : todoRefetch;
  const sections = onDone
    ? doneSections(done?.pages ?? [])
    : todoSections(todo?.workspaces ?? [], {
        ascending,
        sort: sort === 'title' ? 'title' : 'due',
        types,
      });
  const ticks = useTodoTicks(sections, onDone);
  // Rows marked here move tabs at once, and the count with them.
  const open =
    todoCount(todo?.workspaces ?? []) +
    (onDone ? ticks.leaving : -ticks.leaving);

  return (
    <PagePanel header={<PageHeader title={m.nav_todo()} />}>
      <Tabs
        className="page-tabs-px"
        onChange={(next) => {
          ticks.clear();
          setSearch({
            dir: undefined,
            sort: undefined,
            tab: next === 'done' ? 'done' : undefined,
          });
        }}
        tabs={[
          {
            label: (
              <span className="inline-flex items-center gap-1.5">
                {m.todo_tab_todo()}
                {open > 0 && (
                  <span className="rounded-full bg-surface-hover-bg px-1.75 font-bold text-fg-muted text-xs leading-4.5">
                    {open}
                  </span>
                )}
              </span>
            ),
            value: 'todo',
          },
          { label: m.todo_tab_done(), value: 'done' },
        ]}
        value={tab}
      />
      <ListToolbar
        filters={[
          {
            key: 'type',
            label: m.todo_filter_type(),
            onToggle: (value) =>
              setSearch({ type: csv(toggleValue(types, value)) }),
            options: TODO_TYPES.map((value) => ({
              label: value === 'quiz' ? m.todo_type_quiz() : m.todo_type_task(),
              value,
            })),
            selected: types,
          },
        ]}
        onResetFilters={() => setSearch({ type: undefined })}
        selection={
          ticks.count > 0 && (
            <SelectionBar
              allSelected={ticks.allSelected}
              busy={false}
              count={ticks.count}
              onClear={ticks.clear}
              onSelectAll={ticks.selectAll}
            >
              {ticks.toDone.length > 0 && (
                <SelectionAction
                  icon="check"
                  label={m.assignment_mark_as_done()}
                  onClick={() => ticks.markDone(ticks.toDone)}
                />
              )}
              {ticks.toUndo.length > 0 && (
                <SelectionAction
                  icon="undo"
                  label={m.assignment_mark_not_done()}
                  onClick={() => ticks.markNotDone(ticks.toUndo)}
                />
              )}
              {onDone && (
                <SelectionAction
                  danger
                  icon="trash"
                  label={m.action_delete()}
                  onClick={ticks.remove}
                />
              )}
            </SelectionBar>
          )
        }
      />
      <PageBody belowToolbar>
        <div>
          {waitsForConnection(fetchStatus, data) ? (
            <QueryPausedState />
          ) : isLoading ? (
            <SkeletonList count={6} rowHeight={40} />
          ) : !data && error ? (
            <InlineErrorState
              errorId={unexpectedErrorId(error)}
              message={m.todo_error()}
              onRetry={() => void refetch()}
            />
          ) : data ? (
            <TodoTable
              doneTab={onDone}
              sections={sections}
              sorting={sorting}
              ticks={ticks}
            />
          ) : null}
        </div>
        {onDone && (
          <ListEnd
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
          />
        )}
      </PageBody>
    </PagePanel>
  );
}
