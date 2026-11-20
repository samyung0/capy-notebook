import { useState } from 'react';
import { useTodo } from '@/api/hooks';
import type { TodoWorkspace, Workspace } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { Button, PageButton } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { SelectionAction, SelectionBar } from '@/features/files/SelectionBar';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { NewAssignmentDialog } from './LazyNewAssignmentDialog';
import { NewAssignmentMenu } from './NewAssignmentMenu';
import { TodoTable, useTodoTicks } from './TodoTable';
import { type TodoTableSection, todoRows, todoSections } from './todoRows';

/** One workspace's To do, as the To do page's table (Epo 2026-11-12): a box on
 * each row, the row opening its details. It is the Dashboard's To do section
 * (boards H1, H2, H2b; Epo 2026-11-03) and, as `page`, a personal workspace's
 * or a class member's To do page (Epo 2026-11-20: "the two todo should
 * align"), which selects rows with the To do page's selection bar. A member's
 * holds what is assigned to them and the tasks they set themself; staff's
 * holds answers to approve and anything they assigned themselves. At its top
 * right a class's staff and a personal workspace's people have the New menu
 * (Epo 2026-11-14: Assignment or Task, and Graded quiz) and a class's members
 * New task (Epo 2026-11-10: only staff give out assignments); in the section,
 * with rows selected it turns to Mark as done (or Mark as not done for done
 * rows). Done rows leave until Show done brings them back, muted. With nothing
 * in it the table stays and says Nothing to do (Epo 2026-11-10: nothing is
 * hidden that he did not ask to hide); a visitor who is no member has no
 * button. Its rows load as skeletons, and a failed read says so with Retry. */
export function TodoSection({
  manages,
  page = false,
  workspace,
}: {
  manages: boolean;
  /** The workspace's own To do page rather than the Dashboard's section. */
  page?: boolean;
  workspace: Pick<Workspace, 'iconId' | 'id' | 'kind' | 'name' | 'role'>;
}) {
  // To do's own list (the nav's): what this class holds for the viewer, as
  // the To do page shows it, not the paged assignments list.
  const { data, error, isPending, refetch } = useTodo({ errorBoundary: false });
  const revealRef = useLoadingReveal(isPending);
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
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
  // A link or public visitor is no member: nothing is theirs to add.
  const adds = manages || !!workspace.role;
  const addButton =
    adds &&
    (manages || workspace.kind !== 'class' ? (
      <NewAssignmentMenu
        own={!manages}
        small={!page}
        workspaceId={workspace.id}
      />
    ) : page ? (
      <PageButton iconLeft="plus" onClick={() => setCreating(true)}>
        {m.todo_new_task()}
      </PageButton>
    ) : (
      <Button
        className="px-2.5"
        iconLeft="plus"
        onClick={() => setCreating(true)}
        size="sm"
        variant="outline"
      >
        {m.todo_new_task()}
      </Button>
    ));
  const showDoneButton = (done.length > 0 || page) && (
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
  const header = page ? (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.25">
        <h1 className="t-page-title">{m.nav_todo()}</h1>
        {addButton}
      </div>
      {/* Show done, or the To do page's selection bar while rows are
          picked. */}
      <div className="mt-4 mb-1.25 flex min-h-10 items-center gap-2 sm:min-h-11.5 md:mb-2">
        {ticks.count > 0 ? (
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
          </SelectionBar>
        ) : (
          showDoneButton
        )}
      </div>
    </>
  ) : (
    <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
      <h2 className="t-subtitle">{m.dashboard_todo()}</h2>
      <div className="flex items-center gap-2">
        {showDoneButton}
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
          addButton
        )}
      </div>
    </div>
  );
  const Wrapper = page ? 'div' : 'section';
  return (
    <Wrapper className="flex flex-col">
      {header}
      {/* The table once the list has loaded, so Nothing to do never flashes;
          the To do page's rows load meanwhile (Epo 2026-11-12). */}
      {isPending && <SkeletonList count={page ? 4 : 3} rowHeight={40} />}
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
      {creating && (
        <NewAssignmentDialog
          onClose={() => setCreating(false)}
          onDone={() => setCreating(false)}
          // A class member's task for themself (Epo 2026-11-10).
          own
          title={m.todo_new_task()}
          workspaceId={workspace.id}
        />
      )}
    </Wrapper>
  );
}
