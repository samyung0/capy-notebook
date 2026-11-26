import { Link } from '@tanstack/react-router';
import type { Assignment, AssignmentAttempt } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { assignmentsLink } from '../studyRoutes';
import { markText } from './assignmentText';
import { LateBadge } from './LateBadge';

/** Submitted (A4). There is no mark so far (Epo 2026-11-25): a submission is
 * graded once nothing waits for the AI or staff and its grades show, and then
 * its mark and See results show; until then it is being graded, and the way
 * on is back to Assignments. */
export function AssignmentSubmitted({
  assignment,
  attempt,
  onSeeResults,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  onSeeResults: () => void;
}) {
  const graded =
    !attempt.gradesHidden &&
    !attempt.marking &&
    attempt.waitingAnswers === 0 &&
    attempt.waitingMarks === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-4 pt-20 pb-24 text-center sm:pt-[22vh]">
      <span className="grid size-12 place-items-center rounded-full bg-tint-success text-tint-success-fg">
        <Icon name="check" size={22} />
      </span>
      <h1 className="t-page-title mt-4">{m.assignment_submitted()}</h1>
      <p className="mt-2 max-w-xl font-medium text-fg-secondary">
        {m.assignment_submitted_hint({ title: assignment.title })}
      </p>
      {attempt.autoSubmitted && (
        <p className="t-meta mt-1 text-fg-muted">
          {m.assignment_time_ran_out()}
        </p>
      )}
      {graded ? (
        <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 font-medium">
          <span>
            {m.assignment_your_mark()}{' '}
            <b className="font-bold">{markText(attempt.mark, attempt.total)}</b>
          </span>
          {attempt.late && <LateBadge penaltyPct={attempt.latePenaltyPct} />}
        </p>
      ) : (
        <p className="mt-4 font-medium" data-being-graded>
          {m.assignment_being_graded()}
        </p>
      )}
      <div className="mt-5">
        {graded ? (
          <Button
            iconRight="navigationForward"
            onClick={onSeeResults}
            variant="outline"
          >
            {m.assignment_see_results()}
          </Button>
        ) : (
          <Button asChild iconLeft="navigationBack" variant="outline">
            <Link {...assignmentsLink(assignment.workspaceId)}>
              {m.study_panel_assignments()}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
