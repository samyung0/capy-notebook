import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { Assignment, TodoWorkspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { assignmentsLink } from '../studyRoutes';
import { AssignmentFacts } from './AssignmentFacts';
import { fileLink } from './assignmentPage';
import { isGraded } from './assignmentText';
import {
  assignmentFileIcon,
  gradesOnly,
  submissionsText,
  useOpenAssignment,
} from './todoParts';
import { isPlainTask, type TodoRow } from './todoRows';
import { useAssignmentStart } from './useAssignmentStart';

/** A handed-in quiz's or hand-in's line: its mark (a graded Assignment's
 * grade) when it shows, else that it waits for marks, else that it is handed
 * in. */
export function handedInText(a: Assignment) {
  const mine = a.mine;
  if (!isGraded(a) || !mine || a.gradesHidden) return m.todo_submitted();
  if (mine.waitingMarks > 0) return m.todo_waiting_marks();
  if (mine.mark === undefined) return m.todo_submitted();
  return `${formatPoints(mine.mark)}/${formatPoints(mine.total ?? a.marks)}`;
}

/** "Approve AI marks on Past paper" or the work's own title. */
export const rowHeading = (row: TodoRow) =>
  row.approval
    ? `${gradesOnly(row.a) ? m.todo_grade_on() : m.dashboard_approve_on()} ${row.a.title}`
    : row.a.title;

/**
 * A To do row's details (Epo 2026-11-10, round 6 option A): the title alone in
 * the header, then a list of facts with an icon each (workspace, answers
 * waiting, due with how long is left, the quiz's facts, who posted it) and the
 * files, each opening in its workspace. The actions sit in the shared dialog
 * footer (Epo 2026-11-10): a task's Mark as done; a quiz's Start, Continue or See results, an approval's
 * Approve marks, each with Mark as done beside it while it can be ticked.
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
  const { dialog, start, starting } = useAssignmentStart(a.workspaceId);
  const go = (
    label: string,
    run: () => void,
    phoneArrow = true,
    disabled = false
  ) => (
    <Button
      disabled={disabled}
      iconRight="navigationForward"
      // Important: Icon sets display in its inline style.
      iconRightClassName={cn(!phoneArrow && 'max-sm:hidden!')}
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
    // No arrow on phones, so it fits beside Mark as done.
    primary = go(
      gradesOnly(a) ? m.todo_grade() : m.todo_approve_marks(),
      () => {
        void navigate(
          assignmentsLink(a.workspaceId, { assignment: a.id, tab: 'grading' })
        );
      },
      false
    );
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
      // A member's quiz starts right away (Epo 2026-11-25), asking only the
      // submission mode while both are open; staff open its page.
      a.kind === 'marked' && !workspace.manages ? () => start(a) : page,
      true,
      starting
    );
  // A quiz's, hand-in's or approval's own tick, beside its action; ticking
  // one by hand still asks first.
  const second = !plain && canTick && (
    <Button
      // Phones: a borderless button's padding is trimmed so it fits beside
      // the primary on one line at 360px.
      className="max-sm:px-2"
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
  const note = row.approval
    ? null
    : done && !plain
      ? { ok: true, text: `${m.todo_submitted()} · ${handedInText(a)}` }
      : a.mine?.checkedOff
        ? { ok: false, text: m.todo_checked_note() }
        : null;

  return (
    <SimpleDialog
      // The shared dialog's footer, on phones after the content (Epo
      // 2026-11-10: a long title needs the header's width). No Cancel: the
      // corner closes. Its own row keeps the actions at the end on phones
      // too, where the shared footer starts them at the content's edge.
      footer={
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          {second}
          {primary}
        </div>
      }
      onClose={onClose}
      open
      title={
        <span className="flex min-w-0 items-start gap-2.25">
          {a.kind === 'marked' && (
            <span className="mt-0.5 shrink-0 text-(--ctp-teal) max-sm:mt-0">
              <Icon name="quillWrite" size={22} />
            </span>
          )}
          <span className="wrap-break-word min-w-0">{rowHeading(row)}</span>
        </span>
      }
      width={720}
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
        <AssignmentFacts
          a={a}
          approval={row.approval}
          dueLeft={!ticked && !done && !a.closed}
          overdue={overdue}
          waiting={
            <span className="font-semibold text-tint-warning-fg">
              {gradesOnly(a)
                ? submissionsText(a.manage?.toGrade ?? 0)
                : waitingText(a.manage?.toApprove ?? 0)}
            </span>
          }
          workspace={workspace}
        />
        {a.files.length > 0 && (
          <section>
            <h3 className="t-meta mb-1 font-semibold text-fg-muted">
              {m.assignment_field_files()}
            </h3>
            <ul>
              {a.files.map((file) => (
                <li key={file.fileId ?? file.materialId}>
                  {/* The workspace panel's file row: a bare 16px icon, opening
                      the file in its class. */}
                  <Link
                    className="-mx-2 flex min-h-9 items-center gap-2.5 rounded-button px-2 font-medium hover:bg-surface-hover-bg focus-visible:outline-2 focus-visible:outline-action"
                    {...fileLink(a.workspaceId, file)}
                  >
                    <FileIcon
                      className="size-4 shrink-0"
                      name={assignmentFileIcon(file)}
                    />
                    <span className="min-w-0 flex-1 translate-y-px truncate">
                      {file.name}
                    </span>
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
      {dialog}
    </SimpleDialog>
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
                : m.todo_check_submit_body()
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
