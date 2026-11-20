import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useSetAssignmentDone } from '@/api/hooks';
import type { Assignment } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { PracticeFrame } from '../practice/studyPage';
import { BackToAssignments } from './AssignmentAttemptPage';
import { AssignmentFiles } from './AssignmentFiles';
import { dayLabel, kindLabel, markText } from './assignmentText';
import { YourWork } from './HandIns';
import { useAddSubmissionFiles } from './useAddSubmissionFiles';
import { useAssignmentStart } from './useAssignmentStart';

/** An assignment's page for a member (W4). An unmarked one shows its files and
 * Mark as done, or, taking files, Your work and Hand in (S3). A marked one goes on: to its running attempt or results, else
 * to Before you start (A0), straight in without a time limit. */
export function MemberAssignment({ assignment }: { assignment: Assignment }) {
  if (assignment.kind === 'marked')
    return <StartMarked assignment={assignment} />;
  return <Unmarked assignment={assignment} />;
}

function StartMarked({ assignment }: { assignment: Assignment }) {
  const navigate = useNavigate();
  const backToList = () =>
    void navigate({ replace: true, search: {}, to: '.' });
  const { dialog, start, starting } = useAssignmentStart(
    assignment.workspaceId,
    backToList
  );
  const { mine } = assignment;
  const closed = !!assignment.closedAt;
  const attempt = mine?.runningAttemptId ?? mine?.countedAttemptId;
  const once = useRef(false);
  useEffect(() => {
    // Also once the start below lands and the assignment reads its attempt: the
    // start's own callback is lost when this remounts (React's StrictMode).
    if (attempt) {
      void navigate({
        replace: true,
        search: { assignment: assignment.id, attempt },
        to: '.',
      });
      return;
    }
    if (once.current) return;
    once.current = true;
    if (!closed) start(assignment);
  }, [assignment, attempt, closed, navigate, start]);
  return (
    <PracticeFrame>
      <BackToAssignments />
      <h1 className="t-page-title mt-3">{assignment.title}</h1>
      {closed && !mine?.countedAttemptId && (
        <p className="mt-2 text-fg-secondary">{m.assignment_closed_missed()}</p>
      )}
      {/* It starts by itself above; a start that failed is pressed again here. */}
      {!(closed || attempt) && (
        <Button
          className="mt-4"
          disabled={starting}
          onClick={() => start(assignment)}
        >
          {m.assignment_start()}
        </Button>
      )}
      {dialog}
    </PracticeFrame>
  );
}

function Unmarked({ assignment }: { assignment: Assignment }) {
  return (
    <PracticeFrame>
      <BackToAssignments />
      <UnmarkedView assignment={assignment} className="mt-3" />
    </PracticeFrame>
  );
}

/** An unmarked assignment as its members see it: its title, Mark as done or
 * Hand in, its files and Your work. */
export function UnmarkedView({
  assignment,
  className,
}: {
  assignment: Assignment;
  className?: string;
}) {
  const { mutate, isPending } = useSetAssignmentDone(assignment.workspaceId);
  const done = !!assignment.mine?.done;
  const handIn = assignment.allowUploads;
  const closed = !!assignment.closedAt;
  const handedIn = handIn && done && assignment.mine?.doneAt;
  // Your work's uploads, held here: Hand in waits for them, as Submit does.
  const uploads = useAddSubmissionFiles({ handInId: assignment.id });
  const uploading = uploads.uploading.length > 0;
  const meta = [
    kindLabel(assignment),
    assignment.postedBy
      ? m.assignment_posted_by({
          date: dayLabel(assignment.postedAt),
          name: assignment.postedBy,
        })
      : m.assignment_posted({ date: dayLabel(assignment.postedAt) }),
    assignment.dueAt
      ? m.assignment_due({ date: dayLabel(assignment.dueAt) })
      : null,
    handedIn ? m.assignment_handed_in_on({ date: dayLabel(handedIn) }) : null,
    // Graded on points (Epo 2026-11-14): the grade once shown, else what of.
    assignment.points === undefined
      ? null
      : assignment.mine?.mark === undefined
        ? m.assignment_out_of({ points: assignment.points })
        : m.assignment_grade_line({
            grade: markText(
              assignment.mine.mark,
              assignment.mine.total ?? assignment.points
            ),
          }),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <div
        className={cn(
          'flex flex-wrap items-start justify-between gap-x-4 gap-y-3',
          className
        )}
      >
        <div className="min-w-0">
          <h1 className="t-page-title">{assignment.title}</h1>
          <p className="t-meta mt-0.5 text-fg-muted">{meta}</p>
        </div>
        {handIn ? (
          <span
            title={
              uploading && !done
                ? m.assignment_hand_in_wait_upload()
                : undefined
            }
          >
            <Button
              disabled={
                isPending ||
                closed ||
                (!done && (uploading || !assignment.mine?.handIn?.length))
              }
              onClick={() => mutate({ done: !done, id: assignment.id })}
              variant={done ? 'outline' : undefined}
            >
              {done ? m.assignment_undo_hand_in() : m.assignment_hand_in()}
            </Button>
          </span>
        ) : (
          <Button
            disabled={isPending || closed}
            onClick={() => mutate({ done: !done, id: assignment.id })}
            variant={done ? 'outline' : undefined}
          >
            {done ? m.assignment_mark_not_done() : m.assignment_mark_as_done()}
          </Button>
        )}
      </div>
      <AssignmentFiles assignment={assignment} />
      {handIn && (
        <YourWork
          assignment={assignment}
          open={!(done || closed)}
          uploads={uploads}
        />
      )}
    </>
  );
}
