import { useState } from 'react';
import { useTodo } from '@/api/hooks';
import type { TodoWorkspace, Workspace } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { TodoTable, useTodoTicks } from './TodoTable';
import { type TodoTableSection, todoRows, todoSections } from './todoRows';

/** One class's To do, as the To do page's table (Epo 2026-11-12): a box on
 * each row, the row opening its details. It is the Dashboard's To do section
 * (boards H1, H2, H2b; Epo 2026-11-03). A member's holds what is assigned to them;
 * staff's holds answers to approve. Nothing is added here (Epo 2026-11-21:
 * no tasks for oneself; staff give work out from the Assignments page). In the
 * section, with rows selected, Mark as done (or Mark as not done for done
 * rows) shows. Done rows leave until Show done brings them back, muted. With
 * nothing in it the table stays and says Nothing to do (Epo 2026-11-10:
 * nothing is hidden that he did not ask to hide). Its rows load as skeletons,
 * and a failed read says so with Retry. */
export function TodoSection({
  manages,
  workspace,
}: {
  manages: boolean;
  workspace: Pick<Workspace, 'iconId' | 'id' | 'name'>;
}) {
  // To do's own list (the nav's): what this class holds for the viewer, as
  // the To do page shows it, not the paged assignments list.
  const { data, error, isPending, refetch } = useTodo({ errorBoundary: false });
  const revealRef = useLoadingReveal(isPending);
  const [showDone, setShowDone] = useState(false);
  // Newest posted first, as the To do page (Epo 2026-11-20).
  const [sort, setSort] = useState<'posted' | 'due' | 'title'>('posted');
  const [ascending, setAscending] = useState(false);
  const items =
    data?.workspaces.find((w) => w.workspaceId === workspace.id)?.items ?? [];
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
  const showDoneButton = done.length > 0 && (
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
  );
  const header = (
    <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
      <h2 className="t-subtitle">{m.dashboard_todo()}</h2>
      <div className="flex items-center gap-2">
        {showDoneButton}
        {ticks.count > 0 && (
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
        )}
      </div>
    </div>
  );
  return (
    <section className="flex flex-col">
      {header}
      {/* The table once the list has loaded, so Nothing to do never flashes;
          its rows load meanwhile (Epo 2026-11-12). */}
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
        // Fades in as the other pages' lists do once loaded.
        <div ref={revealRef}>
          <TodoTable
            doneTab={false}
            sections={sections}
            single
            sorting={{
              ascending,
              ascendingFirst: ['due', 'title'],
              onSortChange: (next, asc) => {
                setSort(next === 'done' ? 'posted' : next);
                setAscending(asc);
              },
              sort,
            }}
            ticks={ticks}
          />
        </div>
      )}
    </section>
  );
}
