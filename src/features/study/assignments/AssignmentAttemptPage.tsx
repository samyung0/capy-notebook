import { Link } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { useAssignment, useAssignmentAttempt } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { SkeletonList } from '@/components/ui/feedback';
import { IconButton } from '@/components/ui/IconButton';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { PracticeFrame } from '../practice/studyPage';
import {
  type AssignmentsSearch,
  assignmentsLink,
  type studyLink,
} from '../studyRoutes';
import { AssignmentSubmitted } from './AssignmentSubmitted';
import { AssignmentTake } from './AssignmentTake';
import { AttemptResults } from './AttemptResults';
import { questionPaperOf } from './assignmentText';

/** "← Assignments" over an assignment's pages, staff's and members' alike
 * (Epo 2026-11-25); `link` leads elsewhere: a report's tab on this page, or a
 * member's profile on Study. */
export function BackToAssignments({
  label,
  link = { search: {}, to: '.' },
}: {
  label?: string;
  link?:
    | ReturnType<typeof studyLink>
    | ReturnType<typeof assignmentsLink>
    | { search: AssignmentsSearch; to: '.' };
}) {
  return (
    <UnderlineLink
      asChild
      className="self-start justify-self-start text-fg"
      iconLeft="navigationBack"
      noArrow
    >
      <Link {...link}>{label ?? m.study_panel_assignments()}</Link>
    </UnderlineLink>
  );
}

/** The member's profile an attempt was opened from, and its tab. */
export type ProfileOrigin = { member: string; show?: 'topics' };

/** One try, by its id: a running one to answer (A2), then Submitted (A4), or
 * its results (A5), a member's for the class's staff. A member's own opens at
 * `/attempts/$attemptId`, staff's in the workspace; its links name their
 * pages, so it reads the same at either. Staff closing it while it
 * runs here goes straight to its results (Epo 2026-11-05). */
export function AssignmentAttemptPage({
  attemptId,
  fromProfile,
}: {
  attemptId: string;
  /** Opened from a member's profile: back returns there, not to Responses. */
  fromProfile?: ProfileOrigin;
}) {
  const { data, error, isError, isFetchedAfterMount, isPending, refetch } =
    useAssignmentAttempt(attemptId, { errorBoundary: false });
  const {
    data: assignment,
    error: assignmentError,
    isError: assignmentFailed,
    refetch: refetchAssignment,
  } = useAssignment(data?.assignmentId ?? '', { errorBoundary: false });
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
  // A running upload waits for its assignment, which says whether a file is
  // its question paper.
  const paperFirst =
    data?.status === 'running' && data.paper === 'upload' && !assignment;
  if (isPending || waitingForFresh || (paperFirst && !assignmentFailed))
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
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
          title={m.assignment_load_failed()}
          variant="panel"
        />
      </PracticeFrame>
    );
  if (paperFirst)
    return (
      <PracticeFrame>
        <ErrorState
          errorId={unexpectedErrorId(assignmentError)}
          onRetry={() => void refetchAssignment()}
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
            <Link
              {...assignmentsLink(data.workspaceId, {
                assignment: data.assignmentId,
                // Staff taking their own come back to their own view too.
                own: true,
              })}
            />
          </IconButton>
        }
        onClosed={closedHere}
        questionPaper={questionPaperOf(assignment)}
        workspaceId={data.workspaceId}
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
  return (
    <AttemptResults
      assignment={assignment}
      attempt={data}
      fromProfile={fromProfile}
    />
  );
}
