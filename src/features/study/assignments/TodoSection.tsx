import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { qk } from '@/api/client';
import { useAssignments, useSetAssignmentDone } from '@/api/hooks';
import type { Assignment, FileKind, MaterialRefType } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { dayLabel } from './assignmentText';
import { NewAssignmentDialog } from './LazyNewAssignmentDialog';
import { todoRows } from './todoRows';

/** A chip naming a quiz: the assignment's quill, tinted (Epo 2026-11-03);
 * crossed out once done, grey on the To do page's Done tab. */
function WorkChip({
  title,
  done,
}: {
  title: string;
  done?: 'crossed' | 'grey';
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5.5 min-w-0 items-center gap-1 rounded-md px-1.75 font-semibold text-[13px]',
        done === 'crossed' && 'text-fg-muted line-through',
        done === 'grey' && 'bg-surface-hover-bg text-fg-secondary',
        !done && 'bg-tint-accent-1 text-tint-accent-1-fg'
      )}
    >
      <Icon
        className="shrink-0 text-(--ctp-teal)"
        name="quillWrite"
        size={14}
      />
      <span className="truncate">{title}</span>
    </span>
  );
}

function FileChip({
  file,
  grey,
}: {
  file: Assignment['files'][number];
  grey?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5.5 min-w-0 items-center gap-1 rounded-md px-1.75 font-semibold text-[13px]',
        grey
          ? 'bg-surface-hover-bg text-fg-secondary'
          : 'bg-tint-accent-1 text-tint-accent-1-fg'
      )}
    >
      <FileIcon
        className="size-3.5 shrink-0"
        name={
          file.fileId
            ? fileIconName({ kind: file.kind as FileKind, name: file.name })
            : materialIconName(file.kind as MaterialRefType)
        }
      />
      <span className="truncate">{file.name}</span>
    </span>
  );
}

/** The Dashboard's To do (boards H1, H2, H2b; Epo 2026-11-03). A member's holds
 * what is assigned to them: quizzes, and the rest with a tick. Staff's holds
 * what is for them: answers to approve and anything they assigned themselves,
 * with New assignment at its top right. Done rows leave until Show done brings
 * them back, crossed out. Empty, the section doesn't show. */
export function TodoSection({
  manages,
  workspaceId,
}: {
  manages: boolean;
  workspaceId: string;
}) {
  const { data } = useAssignments(workspaceId, { errorBoundary: false });
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const { done, open, toApprove } = todoRows(data?.items ?? [], manages);
  const shown = showDone ? [...open, ...done] : open;
  if (toApprove.length === 0 && shown.length === 0 && done.length === 0)
    return null;
  return (
    <section className="flex flex-col">
      <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
        <h2 className="t-subtitle">{m.dashboard_todo()}</h2>
        <div className="flex items-center gap-2">
          {done.length > 0 && (
            <Button
              className="px-2.5"
              iconLeft="view"
              onClick={() => setShowDone(!showDone)}
              size="sm"
              variant="outline"
            >
              {showDone ? m.assignment_hide_done() : m.assignment_show_done()}
            </Button>
          )}
          {manages && (
            <Button
              className="px-2.5"
              iconLeft="plus"
              onClick={() => setCreating(true)}
              size="sm"
              variant="outline"
            >
              {m.assignment_new()}
            </Button>
          )}
        </div>
      </div>
      <TodoRows
        manages={manages}
        shown={shown}
        toApprove={toApprove}
        workspaceId={workspaceId}
      />
      {creating && (
        <NewAssignmentDialog
          onClose={() => setCreating(false)}
          onDone={() => setCreating(false)}
          workspaceId={workspaceId}
        />
      )}
    </section>
  );
}

/** A To do list's rows, on the Dashboard and the To do page. A row is its own
 * button, with nothing else to press but a tick (Epo 2026-11-05); an assignment's
 * page starts or continues it. Open work past its due date says Overdue. On the
 * To do page's Done tab (`doneTab`) rows say when they were done, uncrossed, or
 * that they closed undone. */
export function TodoRows({
  doneTab = false,
  manages,
  shown,
  toApprove,
  workspaceId,
}: {
  doneTab?: boolean;
  manages: boolean;
  shown: Assignment[];
  toApprove: Assignment[];
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { mutate: setDone } = useSetAssignmentDone(workspaceId);
  const openPage = (a: Assignment) => {
    // Closing at a No late due date sends no event: past it, To do rereads
    // (Epo 2026-11-08) while its page says it closed.
    if (a.noLate && a.dueAt && Date.parse(a.dueAt) <= Date.now())
      void qc.invalidateQueries({ queryKey: qk.todo });
    return navigate({
      params: { workspaceId },
      search: {
        assignment: a.id,
        ...(a.mine?.countedAttemptId && a.kind === 'marked'
          ? { attempt: a.mine.countedAttemptId }
          : {}),
        ...(manages ? { own: true as const } : {}),
        study: 'assignments' as const,
      },
      to: '/workspaces/$workspaceId',
    });
  };
  return (
    <ul className="-mx-1.5 border-divider border-t">
      {toApprove.map((a) => (
        <Row key={a.id}>
          <Link
            className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
            params={{ workspaceId }}
            search={{
              assignment: a.id,
              study: 'assignments' as const,
              tab: 'approve' as const,
            }}
            to="/workspaces/$workspaceId"
          >
            {m.dashboard_approve_on()}
            <span className="flex min-w-0 items-center gap-2">
              <WorkChip title={a.title} />
              <span className="t-meta shrink-0 font-semibold text-tint-warning-fg">
                {m.dashboard_waiting({ count: a.manage?.toApprove ?? 0 })}
              </span>
            </span>
          </Link>
        </Row>
      ))}
      {shown.map((a) => {
        const isDone = !!a.mine?.done;
        const crossed = isDone && !doneTab;
        const overdue =
          !doneTab && !isDone && !!a.dueAt && Date.parse(a.dueAt) <= Date.now();
        const meta = doneTab
          ? doneMeta(a)
          : a.dueAt
            ? (overdue ? m.todo_overdue : m.assignment_due)({
                date: dayLabel(a.dueAt),
              })
            : null;
        return (
          <Row key={a.id}>
            {/* Closed work takes no tick (Epo 2026-11-08); one that takes
                files is handed in from its page (S3). */}
            {a.kind === 'unmarked' && !a.closedAt && !a.allowUploads && (
              <span className="grid w-7 shrink-0 justify-items-start pl-1.5">
                <Checkbox
                  aria-label={a.title}
                  checked={isDone}
                  onChange={(next) => setDone({ done: next, id: a.id })}
                  size={18}
                />
              </span>
            )}
            <button
              className={cn(
                'flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset',
                crossed && 'text-fg-muted line-through',
                doneTab && 'text-fg-secondary'
              )}
              onClick={() => void openPage(a)}
              type="button"
            >
              {a.kind === 'marked' ? (
                <>
                  {doneTab
                    ? isDone
                      ? m.todo_finished()
                      : m.todo_closed()
                    : isDone
                      ? m.dashboard_finish()
                      : m.dashboard_do()}
                  <WorkChip
                    done={doneTab ? 'grey' : isDone ? 'crossed' : undefined}
                    title={a.title}
                  />
                  {a.timeLimitMin && !isDone && !doneTab && (
                    <span className="text-fg-secondary">
                      {m.assignment_minutes_short({ count: a.timeLimitMin })}
                    </span>
                  )}
                </>
              ) : (
                <>
                  {doneTab && !isDone && m.todo_closed()}
                  <span className="min-w-0">{a.title}</span>
                  {a.files.map((file) => (
                    <FileChip
                      file={file}
                      grey={doneTab}
                      key={file.fileId ?? file.materialId}
                    />
                  ))}
                </>
              )}
              {meta && (
                <span
                  className={cn(
                    't-meta shrink-0 text-fg-secondary sm:ml-auto sm:pl-3',
                    crossed && 'text-fg-muted line-through',
                    overdue && 'font-semibold text-tint-error-fg'
                  )}
                >
                  {meta}
                </span>
              )}
            </button>
          </Row>
        );
      })}
    </ul>
  );
}

/** A Done tab row's meta: a quiz's mark or that it waits for one, then the day;
 * closed undone, that and the day it closed. */
function doneMeta(a: Assignment) {
  if (!a.mine?.done)
    return [
      m.assignment_not_done(),
      a.closedAt && m.assignment_closed_on({ date: dayLabel(a.closedAt) }),
    ]
      .filter(Boolean)
      .join(' · ');
  const parts = [
    a.kind === 'marked' && a.mine?.waitingMarks
      ? m.todo_waiting_marks()
      : a.kind === 'marked' && a.mine?.mark !== undefined
        ? `${formatPoints(a.mine.mark)}/${formatPoints(a.mine.total ?? a.marks)}`
        : null,
    a.mine?.doneAt
      ? m.assignment_done_on({ date: dayLabel(a.mine.doneAt) })
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Its hover fills the row, square, past the text's left edge like Activity's. */
function Row({ children }: { children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center border-divider border-b hover:bg-surface-hover-bg">
      {children}
    </li>
  );
}
