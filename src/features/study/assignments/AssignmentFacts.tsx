import type { ReactNode } from 'react';
import type { Assignment, TodoWorkspace } from '@/api/types';
import { Icon, type IconName } from '@/components/ui/Icon';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { formatPoints } from '@/features/quizzes/grade';
import { questionsLabel } from '@/features/study/practice/practiceText';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import {
  dateLabel,
  dateTimeLabel,
  minutesText,
  questionPaperOf,
} from './assignmentText';

/** How a marked assignment may be handed in, in its Settings' words. */
export const submissionText = (a: Assignment) =>
  a.allowUploads
    ? a.uploadOnly
      ? m.assignment_submission_upload()
      : m.assignment_submission_both()
    : m.assignment_submission_online();

/**
 * An assignment's facts with an icon each (Epo 2026-11-10, round 6 option A):
 * its workspace when shown outside it, answers waiting for an approval, due
 * with how long is left, a marked one's quiz, submission, time limit and
 * attempts, and who posted it. The To do dialog and the assignment's own page
 * show the same list (Epo 2026-11-25).
 */
export function AssignmentFacts({
  a,
  approval,
  dueLeft,
  overdue,
  waiting,
  workspace,
}: {
  a: Assignment;
  /** An approval row: answers waiting instead of the member's facts. */
  approval?: boolean;
  /** Whether the due date says how long is left. */
  dueLeft: boolean;
  overdue: boolean;
  waiting?: ReactNode;
  workspace?: Pick<TodoWorkspace, 'iconId' | 'name'>;
}) {
  const facts: { icon: IconName; label: string; value: ReactNode }[] = [];
  if (workspace)
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
  if (approval && waiting)
    facts.push({
      icon: 'clipboard',
      label: m.todo_fact_waiting(),
      value: waiting,
    });
  facts.push({
    icon: 'schedule',
    label: m.todo_fact_due(),
    value: a.dueAt ? (
      <>
        <span className={cn(overdue && 'font-semibold text-tint-error-fg')}>
          {dateTimeLabel(a.dueAt)}
        </span>
        {dueLeft && (
          <span className="t-meta block text-fg-muted">
            {relativeTime(a.dueAt)}
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
      value: m.todo_quiz_size({
        marks:
          a.marks === 1
            ? m.question_ui_one_mark()
            : m.question_ui_marks({ count: formatPoints(a.marks) }),
        questions: a.paperFile
          ? (questionPaperOf(a)?.name ?? m.assignment_question_paper())
          : questionsLabel(a.questions),
      }),
    });
    if (!approval) {
      // What it may be handed in as (Epo 2026-11-25), every mode named.
      facts.push({
        icon: 'upload',
        label: m.assignment_field_submission(),
        value: submissionText(a),
      });
      if (a.timeLimitMin)
        facts.push({
          icon: 'clock',
          label: m.todo_fact_time(),
          value: minutesText(a.timeLimitMin),
        });
      facts.push({
        icon: 'retry',
        label: m.todo_fact_attempts(),
        value:
          a.attempts === 1
            ? m.todo_attempts_one()
            : m.todo_attempts({ count: a.attempts }),
      });
    }
  }
  facts.push({
    icon: 'profile',
    label: m.todo_fact_posted(),
    value: [a.postedBy, dateLabel(a.postedAt)].filter(Boolean).join(' · '),
  });
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3.5 gap-y-3">
      {facts.map(({ icon, label, value }) => (
        <div className="contents" key={label}>
          <dt className="flex min-w-26 items-center gap-2.25 whitespace-nowrap pt-px text-fg-muted text-sm sm:min-w-29.5">
            <Icon className="shrink-0 -translate-y-px" name={icon} size={18} />
            {label}
          </dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
