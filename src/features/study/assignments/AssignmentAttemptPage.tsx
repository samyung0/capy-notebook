import { Link } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { useAssignment, useAssignmentAttempt } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { IconButton } from '@/components/ui/IconButton';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { PracticeFrame } from '../practice/studyPage';
import { AssignmentSubmitted } from './AssignmentSubmitted';
import { AssignmentTake } from './AssignmentTake';
import { AttemptResults } from './AttemptResults';

/** "← Assignments" over an assignment's pages. */
export function BackToAssignments({
  label,
  search,
}: {
  label?: string;
  search?: Record<string, unknown>;
}) {
  return (
    <UnderlineLink
      asChild
      className="self-start justify-self-start text-fg"
      iconLeft="navigationBack"
      noArrow
    >
      <Link search={search ?? { study: 'assignments' as const }} to=".">
        {label ?? m.study_panel_assignments()}
      </Link>
    </UnderlineLink>
  );
}

/** One try, by its id: a running one to answer (A2), then Submitted (A4), or
 * its results (A5), a member's for the class's staff. Staff closing it while it
 * runs here goes straight to its results (Epo 2026-11-05). */
export function AssignmentAttemptPage({
  attemptId,
  workspaceId,
}: {
  attemptId: string;
  workspaceId: string;
}) {
  const { data, error, isError, isFetchedAfterMount, isPending, refetch } =
    useAssignmentAttempt(attemptId, { errorBoundary: false });
  const { data: assignment } = useAssignment(data?.assignmentId ?? '', {
    errorBoundary: false,
  });
  // Seen running on this page, it was submitted here (A4 comes first); opened
  // later, it goes straight to its results.
  const ranHere = useRef(false);
  const [seenResults, setSeenResults] = useState(false);
  const closedHere = useCallback(() => setSeenResults(true), []);
  if (data?.status === 'running') ranHere.current = true;
  // Taking it starts only from this opening's read, never a cached one.
  const waitingForFresh = data?.status === 'running' && !isFetchedAfterMount;
  const readHere = useRef(false);
  if (isFetchedAfterMount && !isError) readHere.current = true;
  if (isPending || waitingForFresh)
    return (
      <PracticeFrame>
        <SkeletonList count={8} rowHeight={36} />
      </PracticeFrame>
    );
  // A refresh that fails leaves the page: it may hold typed answers. Only an
  // opening with nothing to show, or a running attempt it never read, stops.
  if (isError && (!data || (data.status === 'running' && !readHere.current)))
    return (
      <PracticeFrame>
        <ErrorState
          action={
            <Button onClick={() => void refetch()} variant="outline">
              {m.action_retry()}
            </Button>
          }
          errorId={unexpectedErrorId(error)}
          title={m.assignment_load_failed()}
          variant="panel"
        />
      </PracticeFrame>
    );
  if (data.status === 'running')
    return (
      <AssignmentTake
        attempt={data}
        leave={
          <IconButton
            asChild
            className="rounded-input p-1.5"
            icon="navigationBack"
            label={m.assignment_leave()}
            size="sm"
            variant="ghost-hover"
          >
            <Link search={{ study: 'assignments' as const }} to="." />
          </IconButton>
        }
        onClosed={closedHere}
        workspaceId={workspaceId}
      />
    );
  if (ranHere.current && !seenResults && assignment)
    return (
      <AssignmentSubmitted
        assignment={assignment}
        attempt={data}
        onSeeResults={() => setSeenResults(true)}
      />
    );
  if (!assignment)
    return (
      <PracticeFrame>
        <SkeletonList count={8} rowHeight={36} />
      </PracticeFrame>
    );
  return <AttemptResults assignment={assignment} attempt={data} />;
}
