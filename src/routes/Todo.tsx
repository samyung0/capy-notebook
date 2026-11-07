import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useTodo } from '@/api/hooks';
import { InlineErrorState } from '@/components/app/ErrorState';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageBody, PageHeader, PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { SkeletonList } from '@/components/ui/feedback';
import { Tabs } from '@/components/ui/Tabs';
import { TodoRows } from '@/features/study/assignments/TodoSection';
import { todoCount, todoSections } from '@/features/study/assignments/todoRows';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { iconUrl } from '@/lib/icon-catalog';
import {
  commaList,
  csv,
  TODO_TYPES,
  type TodoSearch,
  type TodoSort,
  type TodoType,
} from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';

/** To do (canvas NzaizrnumE4jtTtm4p3BYT, board A; Epo 2026-11-08): tabs To do ·
 * Done, the list pages' Sort and Filter, then each class's rows in a section
 * whose heading opens its Dashboard. Approvals stay in the To do tab. Items
 * stop at 860px, left aligned (Epo 2026-11-05). */
export default function Todo() {
  const { data, error, fetchStatus, isLoading, refetch } = useTodo({
    errorBoundary: false,
  });
  const search = useSearch({ from: '/auth-shell/todo' });
  const navigate = useNavigate({ from: '/todo' });
  const setSearch = (patch: TodoSearch) =>
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) });

  const tab = search.tab ?? 'todo';
  const sorts: SortOption<TodoSort>[] =
    tab === 'done'
      ? [
          { icon: 'clock', label: m.todo_sort_done(), value: 'done' },
          { icon: 'workspaces', label: m.todo_sort_class(), value: 'class' },
        ]
      : [
          { icon: 'schedule', label: m.todo_sort_due(), value: 'due' },
          { icon: 'clock', label: m.todo_sort_posted(), value: 'posted' },
          { icon: 'workspaces', label: m.todo_sort_class(), value: 'class' },
        ];
  const sort =
    sorts.find((s) => s.value === search.sort)?.value ?? sorts[0].value;
  const classes = commaList(search.class);
  const types = commaList(search.type) as TodoType[];
  const workspaces = data?.workspaces ?? [];
  const sections = todoSections(workspaces, {
    classes,
    reversed: search.dir === 'asc',
    sort,
    tab,
    types,
  });
  const open = todoCount(workspaces);

  return (
    <PagePanel header={<PageHeader title={m.nav_todo()} />}>
      <Tabs
        className="page-tabs-px"
        onChange={(next) =>
          setSearch({
            dir: undefined,
            sort: undefined,
            tab: next === 'done' ? 'done' : undefined,
          })
        }
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
            key: 'class',
            label: m.todo_filter_class(),
            onToggle: (value) =>
              setSearch({ class: csv(toggleValue(classes, value)) }),
            options: workspaces.map((w) => ({
              label: w.name,
              value: w.workspaceId,
            })),
            selected: classes,
          },
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
        onResetFilters={() => setSearch({ class: undefined, type: undefined })}
        sortMenu={{
          ascending: search.dir === 'asc',
          onSortChange: (next, ascending) =>
            setSearch({
              dir: ascending ? 'asc' : undefined,
              sort: next === sorts[0].value ? undefined : next,
            }),
          sort,
          sorts,
        }}
      />
      <PageBody belowToolbar>
        <div className="flex max-w-[860px] flex-col gap-5.5">
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
          ) : (
            sections.map(({ shown, toApprove, workspace }) => (
              <section className="flex flex-col" key={workspace.workspaceId}>
                <h2 className="mb-1.5">
                  <Link
                    className="t-subtitle inline-flex min-h-7 max-w-full items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                    params={{ workspaceId: workspace.workspaceId }}
                    preload="intent"
                    to="/workspaces/$workspaceId"
                  >
                    <img
                      alt=""
                      className="size-6 shrink-0 rounded-[5px]"
                      height={24}
                      src={iconUrl(workspace.iconId)}
                      width={24}
                    />
                    <span className="truncate">{workspace.name}</span>
                  </Link>
                </h2>
                <TodoRows
                  doneTab={tab === 'done'}
                  manages={workspace.manages}
                  shown={shown}
                  toApprove={toApprove}
                  workspaceId={workspace.workspaceId}
                />
              </section>
            ))
          )}
        </div>
        {!!data && sections.length === 0 && (
          <p className="t-subtitle py-20 text-center font-normal text-fg-muted">
            {tab === 'done' ? m.todo_done_empty() : m.todo_empty()}
          </p>
        )}
      </PageBody>
    </PagePanel>
  );
}
