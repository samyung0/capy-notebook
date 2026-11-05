import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useAssignments, useSetAssignmentDone } from '@/api/hooks';
import type { Assignment, FileKind, MaterialRefType } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { dayLabel } from './assignmentText';
import { NewAssignmentDialog } from './LazyNewAssignmentDialog';

/** A chip naming a quiz: the assignment's quill, tinted (Epo 2026-11-03). */
function WorkChip({ title, done }: { title: string; done?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-5.5 min-w-0 items-center gap-1 rounded-md px-1.75 font-semibold text-[13px]',
        done
          ? 'text-fg-muted line-through'
          : 'bg-tint-accent-1 text-tint-accent-1-fg'
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

function FileChip({ file }: { file: Assignment['files'][number] }) {
  return (
    <span className="inline-flex h-5.5 min-w-0 items-center gap-1 rounded-md bg-tint-accent-1 px-1.75 font-semibold text-[13px] text-tint-accent-1-fg">
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
 * with New assignment at its top right. A row is its own button, with nothing
 * else to press but a tick (Epo 2026-11-05); an assignment's page starts or
 * continues it. Done rows leave until Show done brings them back, crossed out.
 * Empty, the section doesn't show. */
export function TodoSection({
  manages,
  workspaceId,
}: {
  manages: boolean;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const { data } = useAssignments(workspaceId, { errorBoundary: false });
  const { mutate: setDone } = useSetAssignmentDone(workspaceId);
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const items = data?.items ?? [];
  const toApprove = manages
    ? items.filter((a) => (a.manage?.toApprove ?? 0) > 0)
    : [];
  const mine = items.filter((a) => a.mine && !a.draft && !a.closedAt);
  const open = mine.filter((a) => !a.mine?.done);
  const done = mine.filter((a) => a.mine?.done);
  const openPage = (a: Assignment) =>
    navigate({
      search: {
        assignment: a.id,
        ...(a.mine?.countedAttemptId && a.kind === 'marked'
          ? { attempt: a.mine.countedAttemptId }
          : {}),
        ...(manages ? { own: true as const } : {}),
        study: 'assignments' as const,
      },
      to: '.',
    });
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
      <ul className="-mx-1.5 border-divider border-t">
        {toApprove.map((a) => (
          <Row key={a.id}>
            <Link
              className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
              search={{
                assignment: a.id,
                study: 'assignments' as const,
                tab: 'approve' as const,
              }}
              to="."
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
          const due = a.dueAt
            ? m.assignment_due({ date: dayLabel(a.dueAt) })
            : null;
          return (
            <Row key={a.id}>
              {a.kind === 'unmarked' && (
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
                  isDone && 'text-fg-muted line-through'
                )}
                onClick={() => void openPage(a)}
                type="button"
              >
                {a.kind === 'marked' ? (
                  <>
                    {isDone ? m.dashboard_finish() : m.dashboard_do()}
                    <WorkChip done={isDone} title={a.title} />
                    {a.timeLimitMin && !isDone && (
                      <span className="text-fg-secondary">
                        {m.assignment_minutes_short({ count: a.timeLimitMin })}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="min-w-0">{a.title}</span>
                    {a.files.map((file) => (
                      <FileChip
                        file={file}
                        key={file.fileId ?? file.materialId}
                      />
                    ))}
                  </>
                )}
                {due && (
                  <span
                    className={cn(
                      't-meta shrink-0 text-fg-secondary sm:ml-auto sm:pl-3',
                      isDone && 'text-fg-muted line-through'
                    )}
                  >
                    {due}
                  </span>
                )}
              </button>
            </Row>
          );
        })}
      </ul>
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

/** Its hover fills the row, square, past the text's left edge like Activity's. */
function Row({ children }: { children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center border-divider border-b hover:bg-surface-hover-bg">
      {children}
    </li>
  );
}
