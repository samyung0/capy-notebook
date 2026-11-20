import { useParams, useSearch } from '@tanstack/react-router';
import { AssignmentsPage } from '@/features/study/assignments/AssignmentsPage';

const from = '/auth-shell/workspaces/$workspaceId/assignments';

/** The workspace's To do, Assignments to a class's staff, in its centre. */
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
