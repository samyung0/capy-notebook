import { useState } from 'react';
import { useAssignments } from '@/api/hooks';
import type { TodoWorkspace, Workspace } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { NewAssignmentDialog } from './LazyNewAssignmentDialog';
import { TodoTable, useTodoTicks } from './TodoTable';
import { type TodoTableSection, todoRows, todoSections } from './todoRows';

/** The Dashboard's To do (boards H1, H2, H2b; Epo 2026-11-03), as the To do
 * page's table (Epo 2026-11-12): one class's rows, a box on each, the row
 * opening its details. A member's holds what is assigned to them and the tasks
 * they set themself; staff's holds answers to approve and anything they
 * assigned themselves. At its top right a class's staff have New assignment
 * and everyone else New task (Epo 2026-11-10: only staff give out
 * assignments), which is all a personal workspace has; with rows selected it
 * turns to Mark as done (or Mark as not done for done rows). Done rows leave
 * until Show done brings them back, muted. With nothing in it the section
 * stays and says Nothing to do (Epo 2026-11-10: nothing is hidden that he did
 * not ask to hide); a visitor who is no member has no button. Its rows load as
 * skeletons, and a failed read says so with Retry. */
export function TodoSection({
  manages,
  workspace,
}: {
  manages: boolean;
  workspace: Pick<Workspace, 'iconId' | 'id' | 'name' | 'role'>;
}) {
  const { data, error, isPending, refetch } = useAssignments(workspace.id, {
    errorBoundary: false,
  });
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sort, setSort] = useState<'due' | 'title'>('due');
  const [ascending, setAscending] = useState(true);
  const items = data?.items ?? [];
  const todoWorkspace: TodoWorkspace = {
    iconId: workspace.iconId,
    items,
    manages,
    name: workspace.name,
    workspaceId: workspace.id,
  };
  const [open] = todoSections([todoWorkspace], { ascending, sort, types: [] });
  const done = todoRows(items).done.map((a) => ({
    a,
    approval: false,
    ticked: true,
  }));
  const sections: TodoTableSection[] = [
    {
      rows: [...(open?.rows ?? []), ...(showDone ? done : [])],
      workspace: todoWorkspace,
    },
  ];
  const ticks = useTodoTicks(sections, false, { keepTicked: showDone });
  // A link or public visitor is no member: nothing is theirs to add.
  const adds = manages || !!workspace.role;
  return (
    <section className="flex flex-col">
      <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
        <h2 className="t-subtitle">{m.dashboard_todo()}</h2>
        <div className="flex items-center gap-2">
          {done.length > 0 && (
            <Button
              className="px-2.5"
              iconLeft="view"
              onClick={() => {
                ticks.clear();
                setShowDone(!showDone);
              }}
              size="sm"
              variant="outline"
            >
              {showDone ? m.assignment_hide_done() : m.assignment_show_done()}
            </Button>
          )}
          {ticks.count > 0 ? (
            <>
              {ticks.toUndo.length > 0 && (
                <Button
                  className="px-2.5"
                  iconLeft="undo"
                  onClick={() => ticks.markNotDone(ticks.toUndo)}
                  size="sm"
                  variant="outline"
                >
                  {m.assignment_mark_not_done()}
                </Button>
              )}
              {ticks.toDone.length > 0 && (
                <Button
                  className="px-2.5"
                  iconLeft="check"
                  onClick={() => ticks.markDone(ticks.toDone)}
                  size="sm"
                  variant="outline"
                >
                  {m.assignment_mark_as_done()}
                </Button>
              )}
            </>
          ) : (
            adds && (
              <Button
                className="px-2.5"
                iconLeft="plus"
                onClick={() => setCreating(true)}
                size="sm"
                variant="outline"
              >
                {manages ? m.assignment_new() : m.todo_new_task()}
              </Button>
            )
          )}
        </div>
      </div>
      {/* The table once the list has loaded, so Nothing to do never flashes;
          the To do page's rows load meanwhile (Epo 2026-11-12). */}
      {isPending && <SkeletonList count={3} rowHeight={40} />}
      {!data && error && (
        <InlineErrorState
          className="py-6"
          errorId={unexpectedErrorId(error)}
          message={m.todo_error()}
          onRetry={() => void refetch()}
        />
      )}
      {data && (
        <TodoTable
          doneTab={false}
          sections={sections}
          single
          sorting={{
            ascending,
            ascendingFirst: ['due', 'title'],
            onSortChange: (next, asc) => {
              setSort(next === 'title' ? 'title' : 'due');
              setAscending(asc);
            },
            sort,
          }}
          ticks={ticks}
        />
      )}
      {creating && (
        <NewAssignmentDialog
          onClose={() => setCreating(false)}
          onDone={() => setCreating(false)}
          // Only a class's staff give out assignments (Epo 2026-11-10).
          own={!manages}
          title={manages ? undefined : m.todo_new_task()}
          workspaceId={workspace.id}
        />
      )}
    </section>
  );
}
