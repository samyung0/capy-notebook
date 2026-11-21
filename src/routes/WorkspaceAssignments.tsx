import { useParams, useSearch } from '@tanstack/react-router';
import { AssignmentsPage } from '@/features/study/assignments/AssignmentsPage';

const from = '/auth-shell/workspaces/$workspaceId/assignments';

/** A class's To do, Assignments to its staff, in the workspace's centre. */
export default function WorkspaceAssignments() {
  const { workspaceId } = useParams({ from });
  const {
    assignment,
    attempt,
    by,
    fullscreen,
    member,
    own,
    question,
    show,
    tab,
    work,
  } = useSearch({ from });
  return (
    <AssignmentsPage
      search={{
        assignment,
        attempt,
        by,
        fullscreen,
        member,
        own,
        question,
        show,
        tab,
        work,
      }}
      workspaceId={workspaceId}
    />
  );
}
