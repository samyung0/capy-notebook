import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAssignmentAttempt, useSetAssignmentDone } from '@/api/hooks';
import type { Assignment, AssignmentAttempt } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';
import { PracticeFrame } from '../practice/studyPage';
import { attemptLink } from '../studyRoutes';
import { AssignmentFacts } from './AssignmentFacts';
import { AssignmentFiles } from './AssignmentFiles';
import {
  AssignmentHead,
  memberChips,
  type Stat,
  StatRow,
} from './AssignmentHead';
import {
  ClockChip,
  earliest,
  HOUR,
  TimeLeft,
  useTimeLeft,
} from './assignmentClock';
import { dayLabel, markText, startsLeft } from './assignmentText';
import { YourWork } from './HandIns';
import { useAddSubmissionFiles } from './useAddSubmissionFiles';
import { useAssignmentStart } from './useAssignmentStart';

/** An assignment's page for a member (W4), in its staff's report's head with
 * no tabs (Epo 2026-11-25): only their own work is on it. An unmarked one
 * shows its files and Mark as done, or, taking files, Your work and Hand in
 * (S3). A marked one shows its facts and files with Start (Epo 2026-11-25: it
 * waits for the member instead of starting by itself); a running attempt
 * shows its clock and Continue, and results open. */
export function MemberAssignment({ assignment }: { assignment: Assignment }) {
  if (assignment.kind === 'marked')
    return <StartMarked assignment={assignment} />;
  return <Unmarked assignment={assignment} />;
}

/** Started from this page, kept outside it: the start's own callback is lost
 * when the page remounts as the assignment rereads (React's StrictMode). */
const startedHere = new Set<string>();

function StartMarked({ assignment }: { assignment: Assignment }) {
  const navigate = useNavigate();
  const { dialog, start, starting } = useAssignmentStart(
    assignment.workspaceId
  );
  const { mine } = assignment;
  const closed = !!assignment.closedAt;
  const running = mine?.runningAttemptId;
  const counted = mine?.countedAttemptId;
  const left = startsLeft(assignment);
  useEffect(() => {
    // A running attempt waits for Continue (Epo 2026-11-25), unless it was
    // just started here; results open on their own page.
    if (running && startedHere.delete(assignment.id))
      void navigate(attemptLink(running));
    else if (!running && counted)
      void navigate({ ...attemptLink(counted), replace: true });
  }, [assignment.id, counted, navigate, running]);
  const overdue =
    !!assignment.dueAt && Date.parse(assignment.dueAt) <= Date.now() && !closed;
  return (
    <PracticeFrame>
      <AssignmentHead
        actions={
          running ? (
            <>
              <RunningClock attemptId={running} />
              <Button asChild variant="accent">
                <Link {...attemptLink(running)}>{m.assignment_continue()}</Link>
              </Button>
            </>
          ) : (
            !(closed || counted) && (
              <Button
                disabled={starting || !(left.online || left.upload)}
                onClick={() => {
                  startedHere.add(assignment.id);
                  start(assignment);
                }}
                variant="accent"
              >
                {m.assignment_start()}
              </Button>
            )
          )
        }
        assignment={assignment}
        // The facts below give the due date with what is left.
        chips={memberChips(assignment, true)}
        rule
      />
      {closed && !counted && (
        <p className="mt-2 text-fg-secondary">{m.assignment_closed_missed()}</p>
      )}
      <div className="tab-body-mt">
        <AssignmentFacts a={assignment} dueLeft={!closed} overdue={overdue} />
      </div>
      <AssignmentFiles assignment={assignment} />
      {dialog}
    </PracticeFrame>
  );
}

/** The running attempt's clock beside Continue, as the take page shows it:
 * its time limit, or the last hour before a No late close; with neither, In
 * progress. */
function RunningClock({ attemptId }: { attemptId: string }) {
  const { data } = useAssignmentAttempt(attemptId, { errorBoundary: false });
  if (!data) return null;
  return <Clock attempt={data} />;
}

function Clock({ attempt }: { attempt: AssignmentAttempt }) {
  const left = useTimeLeft(
    earliest(attempt.deadlineAt, attempt.closesAt),
    attempt.now,
    attempt.deadlineAt ? undefined : HOUR
  );
  if (left !== null && (!!attempt.deadlineAt || left <= HOUR))
    return <TimeLeft ms={left} />;
  return <ClockChip>{m.assignment_in_progress()}</ClockChip>;
}

/** An unmarked assignment as its members see it: the head with Mark as done
 * or Hand in, their own numbers, its files and Your work. Hand in is final
 * (Epo 2026-11-25): it asks first, as Submit does, and leaves no Undo. */
function Unmarked({ assignment }: { assignment: Assignment }) {
  const { mutate, isPending } = useSetAssignmentDone(assignment.workspaceId);
  const mine = assignment.mine;
  const done = !!mine?.done;
  const handIn = assignment.allowUploads;
  const closed = !!assignment.closedAt;
  const count = mine?.handIn?.length ?? 0;
  const [confirming, setConfirming] = useState(false);
  // Your work's uploads, held here: Hand in waits for them, as Submit does.
  const uploads = useAddSubmissionFiles({ handInId: assignment.id });
  const uploading = uploads.uploading.length > 0;
  // Their own numbers where staff see everyone's (Epo 2026-11-25): when it was
  // handed in or done, and a graded one's grade once given and shown.
  const stats: Stat[] = [
    {
      label: handIn ? m.assignment_col_submitted_at() : m.assignment_done(),
      value: mine?.doneAt ? dayLabel(mine.doneAt) : '–',
    },
  ];
  if (assignment.points !== undefined)
    stats.push({
      label: m.assignment_col_grade(),
      value:
        mine?.mark === undefined
          ? '–'
          : markText(mine.mark, mine.total ?? assignment.points),
    });
  return (
    <PracticeFrame>
      <AssignmentHead
        actions={
          handIn ? (
            !done && (
              <span
                title={
                  uploading ? m.assignment_hand_in_wait_upload() : undefined
                }
              >
                <Button
                  disabled={isPending || closed || uploading || !count}
                  onClick={() => setConfirming(true)}
                >
                  {m.assignment_hand_in()}
                </Button>
              </span>
            )
          ) : (
            <Button
              disabled={isPending || closed}
              onClick={() => mutate({ done: !done, id: assignment.id })}
              variant={done ? 'outline' : undefined}
            >
              {done
                ? m.assignment_mark_not_done()
                : m.assignment_mark_as_done()}
            </Button>
          )
        }
        assignment={assignment}
        chips={memberChips(assignment)}
        rule
      />
      <StatRow stats={stats} />
      <AssignmentFiles assignment={assignment} />
      {handIn && (
        <YourWork
          assignment={assignment}
          open={!(done || closed)}
          uploads={uploads}
        />
      )}
      {confirming && (
        <ConfirmDialog
          body={
            count === 1
              ? m.assignment_hand_in_confirm_one()
              : m.assignment_hand_in_confirm({ count })
          }
          confirmLabel={m.assignment_hand_in()}
          danger={false}
          onClose={() => setConfirming(false)}
          onConfirm={() => mutate({ done: true, id: assignment.id })}
          open
          title={m.assignment_hand_in_title()}
        />
      )}
    </PracticeFrame>
  );
}
