import { Link } from '@tanstack/react-router';
import type {
  Assignment,
  AssignmentAttempt,
  AssignmentGradedQuestion,
} from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { m } from '@/i18n';
import { dayLabel, markText, minutesText } from './assignmentText';
import { LateBadge } from './LateBadge';
import { MarkingNow } from './MarkingNow';

/** Submitted (A4): the mark so far, what still waits for the owner, and the
 * links on. */
export function AssignmentSubmitted({
  assignment,
  attempt,
  onSeeResults,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  onSeeResults: () => void;
}) {
  const answered = (attempt.questions as AssignmentGradedQuestion[]).filter(
    (q) => q.parts.some((p) => attempt.answers[p.id] !== undefined)
  ).length;
  const minutes =
    attempt.startedAt && attempt.submittedAt
      ? Math.max(
          1,
          Math.round(
            (Date.parse(attempt.submittedAt) - Date.parse(attempt.startedAt)) /
              60_000
          )
        )
      : null;
  const line = [
    assignment.title,
    m.assignment_answered_of({
      answered,
      total: attempt.questions.length,
    }),
    minutes ? minutesText(minutes) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const decided = attempt.total - attempt.waitingMarks;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-4 pt-20 pb-24 text-center sm:pt-[22vh]">
      <span className="grid size-12 place-items-center rounded-full bg-tint-success text-tint-success-fg">
        <Icon name="check" size={22} />
      </span>
      <h1 className="t-page-title mt-4">{m.assignment_submitted()}</h1>
      <p className="mt-2 font-medium text-fg-secondary">{line}</p>
      {attempt.autoSubmitted ? (
        <p className="t-meta mt-1 text-fg-muted">
          {m.assignment_time_ran_out()}
        </p>
      ) : (
        assignment.closedAt && (
          <p className="t-meta mt-1 text-fg-muted">
            {m.assignment_closed_on({ date: dayLabel(assignment.closedAt) })}
          </p>
        )
      )}
      {/* A marking run holds it now, from right after Submit (Q729). */}
      {attempt.marking && <MarkingNow className="mt-4" />}
      {attempt.gradesHidden ? (
        // Show grades Manual (S7): no mark until staff release it.
        <p className="mt-4 font-medium">
          {assignment.postedBy
            ? m.assignment_grade_waits({ name: assignment.postedBy })
            : m.assignment_grade_waits_anon()}
        </p>
      ) : (
        <>
          <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 font-medium">
            <span>
              {m.assignment_mark_so_far()}{' '}
              <b className="font-bold">{markText(attempt.mark, decided)}</b>
            </span>
            {attempt.late && <LateBadge penaltyPct={attempt.latePenaltyPct} />}
          </p>
          {attempt.waitingAnswers > 0 && (
            <p className="t-meta mt-2 text-fg-secondary">
              {attempt.waitingAnswers === 1
                ? m.assignment_waiting_one({ name: assignment.postedBy })
                : m.assignment_waiting({
                    count: attempt.waitingAnswers,
                    name: assignment.postedBy,
                  })}
            </p>
          )}
        </>
      )}
      <div className="mt-5 flex items-center gap-6">
        <UnderlineLink
          asChild
          className="text-fg"
          iconLeft="navigationBack"
          noArrow
        >
          {/* A task with no workspace goes back to To do, which holds it. */}
          <Link search={{}} to=".">
            {assignment.workspaceId
              ? m.workspace_section_dashboard()
              : m.nav_todo()}
          </Link>
        </UnderlineLink>
        <UnderlineLink className="text-fg" onClick={onSeeResults}>
          {m.assignment_see_results()}
        </UnderlineLink>
      </div>
    </div>
  );
}
