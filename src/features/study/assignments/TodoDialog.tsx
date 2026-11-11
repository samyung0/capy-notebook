import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useDeleteAssignment, useTodoTick } from '@/api/hooks';
import type { Assignment, TodoWorkspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon, type IconName } from '@/components/ui/Icon';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { formatPoints } from '@/features/quizzes/grade';
import { questionsLabel } from '@/features/study/practice/practiceText';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { assignmentPage, fileLink } from './assignmentPage';
import { dateLabel, dateTimeLabel, minutesText } from './assignmentText';
import { NewAssignmentDialog } from './LazyNewAssignmentDialog';
import { assignmentFileIcon, useOpenAssignment } from './TodoSection';
import { isPlainTask, isTicked, type TodoRow } from './todoRows';

/** A handed-in quiz's or hand-in's line: its mark when it shows, else that it
 * waits for marks, else that it is handed in. */
export function handedInText(a: Assignment) {
  const mine = a.mine;
  if (a.kind !== 'marked' || !mine || a.gradesHidden) return m.todo_handed_in();
  if (mine.waitingMarks > 0) return m.todo_waiting_marks();
  if (mine.mark === undefined) return m.todo_handed_in();
  return `${formatPoints(mine.mark)}/${formatPoints(mine.total ?? a.marks)}`;
}

/** "Approve AI marks on Past paper" or the work's own title. */
export const rowHeading = (row: TodoRow) =>
  row.approval ? `${m.dashboard_approve_on()} ${row.a.title}` : row.a.title;

/**
 * A To do row's details (Epo 2026-11-10, round 6 option A): the title alone in
 * the header, then a list of facts with an icon each (workspace, answers
 * waiting, due with how long is left, the quiz's facts, who posted it) and the
 * files, each opening in its workspace. The actions sit in the shared dialog
 * footer (Epo 2026-11-10): a task's Mark as done; a quiz's Start, Continue or See results, an approval's
 * Approve marks, each with Mark as done beside it while it can be ticked. A task
 * its viewer set themself (`own`) has Delete and Edit there too.
 */
export function TodoDialog({
  canTick,
  onClose,
  onTick,
  row,
  ticked,
  workspace,
}: {
  canTick: boolean;
  onClose: () => void;
  onTick: (checked: boolean) => void;
  row: TodoRow;
  ticked: boolean;
  workspace: TodoWorkspace;
}) {
  const navigate = useNavigate();
  const openPage = useOpenAssignment();
  const { a } = row;
  const done = !!a.mine?.done;
  const plain = isPlainTask(a);
  const [asking, setAsking] = useState<'edit' | 'delete' | null>(null);
  const { mutate: remove } = useDeleteAssignment(a.workspaceId);
  const go = (label: string, run: () => void) => (
    <Button
      iconRight="navigationForward"
      onClick={run}
      size="lg"
      type="button"
      variant="accent"
    >
      {label}
    </Button>
  );
  const page = () => void openPage(a, workspace.manages);
  let primary: ReactNode = null;
  if (row.approval)
    primary = go(m.todo_approve_marks(), () => {
      void navigate(assignmentPage(a, { tab: 'approve' }));
    });
  else if (plain)
    primary = canTick && (
      <Button
        className={cn(ticked && 'text-tint-success-fg')}
        iconLeft="check"
        onClick={() => onTick(!ticked)}
        size="lg"
        type="button"
        variant={ticked ? 'outline' : 'accent'}
      >
        {ticked ? m.todo_done_button() : m.assignment_mark_as_done()}
      </Button>
    );
  else if (done)
    primary = go(
      a.kind === 'marked' ? m.todo_see_results() : m.assignment_open(),
      page
    );
  else if (!a.closed)
    primary = go(
      a.kind === 'unmarked'
        ? m.assignment_hand_in()
        : a.mine?.runningAttemptId
          ? m.todo_continue_quiz()
          : m.todo_start_quiz(),
      page
    );
  // A quiz's, hand-in's or approval's own tick, beside its action; ticking
  // one by hand still asks first.
  const second = !plain && canTick && (
    <Button
      iconLeft="check"
      onClick={() => onTick(!ticked)}
      size="lg"
      type="button"
      variant="ghost-hover"
    >
      {ticked ? m.assignment_mark_not_done() : m.assignment_mark_as_done()}
    </Button>
  );

  const overdue =
    !ticked && !!a.dueAt && Date.parse(a.dueAt) <= Date.now() && !a.closed;
  const facts: { icon: IconName; label: string; value: ReactNode }[] = [];
  // A task with no workspace has no such row (Epo 2026-11-10).
  if (workspace.workspaceId)
    facts.push({
      icon: 'workspaces',
      label: m.todo_fact_workspace(),
      value: (
        <span className="flex min-w-0 items-center gap-2">
          <img
            alt=""
            className="size-4.5 shrink-0 rounded-[4px]"
            height={18}
            src={iconUrl(workspace.iconId)}
            width={18}
          />
          <span className="truncate">{workspace.name}</span>
        </span>
      ),
    });
  if (row.approval)
    facts.push({
      icon: 'clipboard',
      label: m.todo_fact_waiting(),
      value: (
        <span className="font-semibold text-tint-warning-fg">
          {waitingText(a.manage?.toApprove ?? 0)}
        </span>
      ),
    });
  facts.push({
    icon: 'schedule',
    label: m.todo_fact_due(),
    value: a.dueAt ? (
      <>
        <span className={cn(overdue && 'font-semibold text-tint-error-fg')}>
          {dateTimeLabel(a.dueAt)}
        </span>
        {!ticked && !done && !a.closed && (
          <span className="t-meta block text-fg-muted">
            {relativeTime(a.dueAt)}
          </span>
        )}
        {a.noLate && (
          <span className="t-meta block text-fg-muted">
            {m.todo_closes_at_due()}
          </span>
        )}
      </>
    ) : (
      <span className="text-fg-muted">{m.todo_no_due()}</span>
    ),
  });
  if (a.kind === 'marked') {
    facts.push({
      icon: 'list',
      label: m.todo_fact_quiz(),
      value: (
        <>
          {m.todo_quiz_size({
            marks:
              a.marks === 1
                ? m.question_ui_one_mark()
                : m.question_ui_marks({ count: formatPoints(a.marks) }),
            questions: questionsLabel(a.questions),
          })}
          {a.allowUploads && (
            <span className="t-meta block text-fg-muted">
              {m.todo_on_paper()}
            </span>
          )}
        </>
      ),
    });
    if (a.timeLimitMin && !row.approval)
      facts.push({
        icon: 'clock',
        label: m.todo_fact_time(),
        value: minutesText(a.timeLimitMin),
      });
    if (!row.approval)
      facts.push({
        icon: 'retry',
        label: m.todo_fact_attempts(),
        value:
          a.attempts === 1
            ? m.todo_attempts_one()
            : m.todo_attempts({ count: a.attempts }),
      });
  }
  facts.push({
    icon: 'profile',
    label: m.todo_fact_posted(),
    value: [a.postedBy, dateLabel(a.postedAt)].filter(Boolean).join(' · '),
  });

  const note = row.approval
    ? null
    : done && !plain
      ? { ok: true, text: `${m.todo_handed_in()} · ${handedInText(a)}` }
      : a.mine?.checkedOff
        ? { ok: false, text: m.todo_checked_note() }
        : null;

  if (asking === 'edit')
    return (
      <NewAssignmentDialog
        existing={a}
        onClose={() => setAsking(null)}
        onDone={onClose}
        workspaceId={a.workspaceId}
      />
    );
  if (asking === 'delete')
    return (
      <ConfirmDialog
        body={m.todo_delete_task_body()}
        confirmLabel={m.action_delete()}
        onClose={() => setAsking(null)}
        // Its row goes with it, so the details close too.
        onConfirm={() => remove(a.id, { onSuccess: onClose })}
        open
        title={m.todo_delete_task_title({ title: a.title })}
      />
    );
  return (
    <SimpleDialog
      // The shared dialog's footer, on phones after the content (Epo
      // 2026-11-10: a long title needs the header's width). No Cancel: the
      // corner closes.
      footer={
        <>
          {a.own && (
            <>
              <Button
                iconLeft="trash"
                onClick={() => setAsking('delete')}
                size="lg"
                type="button"
                variant="ghost-hover"
              >
                {m.action_delete()}
              </Button>
              <Button
                iconLeft="pencil"
                onClick={() => setAsking('edit')}
                size="lg"
                type="button"
                variant="ghost-hover"
              >
                {m.action_edit()}
              </Button>
            </>
          )}
          {second}
          {primary}
        </>
      }
      onClose={onClose}
      open
      title={
        <span className="flex min-w-0 items-start gap-2.25">
          {(row.approval || a.kind === 'marked') && (
            <span className="mt-0.5 shrink-0 text-(--ctp-teal) max-sm:mt-0">
              <Icon name="quillWrite" size={22} />
            </span>
          )}
          <span className="wrap-break-word min-w-0">{rowHeading(row)}</span>
        </span>
      }
      width={600}
    >
      <div className="flex flex-col gap-5.5 pt-2">
        {note && (
          <p
            className={cn(
              't-meta rounded-md bg-surface-hover-bg px-2.5 py-2 font-semibold',
              note.ok ? 'text-tint-success-fg' : 'text-fg-secondary'
            )}
          >
            {note.text}
          </p>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3.5 gap-y-3">
          {facts.map(({ icon, label, value }) => (
            <div className="contents" key={label}>
              <dt className="flex min-w-26 items-center gap-2.25 whitespace-nowrap pt-px text-fg-muted text-sm sm:min-w-29.5">
                <Icon
                  className="shrink-0 -translate-y-px"
                  name={icon}
                  size={18}
                />
                {label}
              </dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
        {a.files.length > 0 && (
          <section>
            <h3 className="t-meta mb-1 font-semibold text-fg-muted">
              {m.assignment_field_files()}
            </h3>
            <ul>
              {a.files.map((file) => (
                <li key={file.fileId ?? file.materialId}>
                  {/* The workspace panel's file row: a bare 16px icon. It
                      opens where the file sits, which for a task of one's own
                      need not be the task's workspace (Epo 2026-11-11). */}
                  <Link
                    className="-mx-2 flex min-h-9 items-center gap-2.5 rounded-button px-2 font-medium hover:bg-surface-hover-bg focus-visible:outline-2 focus-visible:outline-action"
                    {...fileLink(file)}
                  >
                    <FileIcon
                      className="size-4 shrink-0"
                      name={assignmentFileIcon(file)}
                    />
                    <span className="min-w-0 flex-1 translate-y-px truncate">
                      {file.name}
                    </span>
                    {file.workspaceName &&
                      file.workspaceId !== a.workspaceId && (
                        <span className="t-meta max-w-[40%] shrink-0 truncate text-fg-muted">
                          {file.workspaceName}
                        </span>
                      )}
                    <Icon
                      className="shrink-0 text-fg-muted"
                      name="navigationForward"
                      size={18}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </SimpleDialog>
  );
}

/** A task its viewer set themself, opened inside its workspace (the Dashboard's
 * To do, a member's To do): To do's details, ticked here as the To do page
 * ticks. A plain task's tick is its done; a quiz's or a hand-in's asks first
 * and only clears To do, and a submitted one can't be unticked. */
export function OwnTaskDetails({
  onClose,
  task,
  workspace,
}: {
  onClose: () => void;
  task: Assignment;
  workspace: { iconId: string; id: string; name: string };
}) {
  const { mutate: tick } = useTodoTick();
  const [asking, setAsking] = useState(false);
  const plain = isPlainTask(task);
  const ticked = isTicked(task);
  const row = { a: task, approval: false, ticked };
  const send = (checked: boolean) => {
    tick([{ checked, id: task.id, task: plain, workspaceId: workspace.id }]);
    onClose();
  };
  if (asking)
    return (
      <TodoCheckDialog
        onClose={onClose}
        onConfirm={() => send(true)}
        rows={[row]}
      />
    );
  return (
    <TodoDialog
      canTick={!task.closed && (plain || !task.mine?.done)}
      onClose={onClose}
      onTick={(checked) =>
        checked && !plain ? setAsking(true) : send(checked)
      }
      row={row}
      ticked={ticked}
      workspace={{
        iconId: workspace.iconId,
        items: [],
        manages: false,
        name: workspace.name,
        workspaceId: workspace.id,
      }}
    />
  );
}

export const waitingText = (count: number) =>
  count === 1
    ? m.todo_answers_waiting_one()
    : m.todo_answers_waiting({ count });

/** Asked before a quiz, a hand-in or the answers waiting is ticked off To do by
 * hand (Epo 2026-11-10): it goes ahead, since nothing is submitted. Several
 * rows marked at once ask once. */
export function TodoCheckDialog({
  onClose,
  onConfirm,
  rows,
}: {
  onClose: () => void;
  onConfirm: () => void;
  rows: TodoRow[];
}) {
  const [row] = rows;
  const one = rows.length === 1 && row;
  return (
    <ConfirmDialog
      confirmLabel={m.assignment_mark_as_done()}
      danger={false}
      onClose={onClose}
      onConfirm={onConfirm}
      open
      title={
        one
          ? one.approval
            ? m.todo_check_approvals_title({ title: one.a.title })
            : m.todo_check_title({ title: one.a.title })
          : m.todo_check_many_title({ count: rows.length })
      }
    >
      <p className="flex items-start gap-2.5 rounded-md bg-tint-warning px-3 py-2.5 text-sm">
        <Icon
          className="mt-px shrink-0 text-tint-warning-fg"
          name="alert"
          size={18}
        />
        <span>
          {one
            ? one.approval
              ? m.todo_check_approvals_body()
              : one.a.kind === 'marked'
                ? m.todo_check_quiz_body()
                : m.todo_check_hand_in_body()
            : m.todo_check_many_body()}
        </span>
      </p>
    </ConfirmDialog>
  );
}

/** Done's Delete (Epo 2026-11-10): the rows leave the caller's Done list only. */
export function TodoRemoveDialog({
  onClose,
  onConfirm,
  rows,
}: {
  onClose: () => void;
  onConfirm: () => void;
  rows: TodoRow[];
}) {
  const [row] = rows;
  const one = rows.length === 1 && row;
  return (
    <ConfirmDialog
      body={one ? m.todo_remove_body() : m.todo_remove_body_many()}
      confirmLabel={m.action_delete()}
      onClose={onClose}
      onConfirm={onConfirm}
      open
      title={
        one
          ? m.todo_remove_title({ title: one.a.title })
          : m.todo_remove_many_title({ count: rows.length })
      }
    />
  );
}
