import type { ReactNode } from 'react';
import type { Assignment } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { BackToAssignments } from './AssignmentAttemptPage';
import { dayLabel } from './assignmentText';

export const minutesShort = (count: number) =>
  m.assignment_minutes_short({ count });

export const CHIP =
  'inline-flex h-5.5 shrink-0 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs';

/** An assignment page's head, its staff's report and a member's page alike
 * (Epo 2026-11-25): Back, the title, its chips under it (Open in green first,
 * then the time limit) and the actions at the chips' right. `back` replaces
 * the plain "← Assignments"; `rule` draws a line under it where the report
 * has its tabs (a member's page, mock NgtaKfyZp9yk2uh9Ysxhhi). */
export function AssignmentHead({
  actions,
  assignment,
  back,
  chips,
  rule = false,
}: {
  actions?: ReactNode;
  assignment: Assignment;
  back?: ReactNode;
  /** After Open and the time limit: strings as plain chips, or nodes. */
  chips: ReactNode[];
  rule?: boolean;
}) {
  return (
    <>
      {/* Stepped aside past a phone's first Approve screen (tailwind.css). */}
      <div className="flex" data-report-head>
        {back ?? <BackToAssignments />}
      </div>
      <div className="mt-3" data-report-head>
        <h1 className="t-page-title truncate" title={assignment.title}>
          {assignment.title}
        </h1>
        {/* One row, never wrapping (Epo 2026-11-20): the actions stay at the
            chips' right, and chips past the room scroll, as Grading's do. */}
        <div className="mt-1 flex items-center gap-2 sm:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* Published and not closed yet: Open, in green, first (Epo 2026-11-16). */}
            {!assignment.draft && !assignment.closedAt && (
              <span
                className={cn(CHIP, 'bg-tint-success text-tint-success-fg')}
              >
                {m.assignment_state_open()}
              </span>
            )}
            {/* The time limit alone, with no kind before it. */}
            {assignment.timeLimitMin ? (
              <span className={cn(CHIP, 'gap-1')}>
                <Icon className="shrink-0" name="clock" size={14} />
                {minutesShort(assignment.timeLimitMin)}
              </span>
            ) : null}
            {chips.map((chip, i) =>
              typeof chip === 'string' ? (
                <span className={CHIP} key={chip}>
                  {chip}
                </span>
              ) : (
                <span className="contents" key={i}>
                  {chip}
                </span>
              )
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      </div>
      {rule && <div className="mt-3.5 border-divider border-b" />}
    </>
  );
}

/** The facts both kinds of page chip: due, the late rule and when it closed. */
export const factChips = (a: Assignment) => [
  a.dueAt ? m.assignment_due({ date: dayLabel(a.dueAt) }) : null,
  a.noLate
    ? m.assignment_switch_no_late()
    : a.latePenaltyPct > 0
      ? m.assignment_late_penalty({ percent: a.latePenaltyPct })
      : null,
  a.closedAt ? m.assignment_closed_on({ date: dayLabel(a.closedAt) }) : null,
];

/** A member's chips (Epo 2026-11-25): the shared facts, then what it is
 * marked out of, a graded quiz's marks or a graded Assignment's points.
 * `noDue` leaves the due date to a facts list below. */
export const memberChips = (a: Assignment, noDue?: boolean) =>
  [
    ...factChips(noDue ? { ...a, dueAt: undefined } : a),
    a.kind === 'marked'
      ? a.marks === 1
        ? m.question_ui_one_mark()
        : m.question_ui_marks({ count: formatPoints(a.marks) })
      : a.points === undefined
        ? null
        : m.assignment_out_of({ points: a.points }),
  ].filter((chip) => chip !== null);

export interface Stat {
  label: string;
  value: ReactNode;
}

/** An assignment's numbers in a row (Epo 2026-11-22): staff's over everyone,
 * a member's their own (Epo 2026-11-25). `end` sits at the row's end. */
export function StatRow({
  className,
  end,
  stats,
}: {
  className?: string;
  end?: ReactNode;
  stats: Stat[];
}) {
  return (
    <div
      className={cn(
        'tab-body-mt mb-2 flex shrink-0 flex-wrap items-center gap-x-10 gap-y-3',
        className
      )}
    >
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt className="t-meta text-fg-muted">{stat.label}</dt>
            <dd className="mt-0.5 font-bold text-xl">{stat.value}</dd>
          </div>
        ))}
      </dl>
      {end && <div className="ml-auto">{end}</div>}
    </div>
  );
}
