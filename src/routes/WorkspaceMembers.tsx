import { useParams } from '@tanstack/react-router';
import { MembersPage } from '@/features/study/members/MembersPage';

/** The workspace's Members, in its centre. */
export default function WorkspaceMembers() {
  const { workspaceId } = useParams({
    from: '/auth-shell/workspaces/$workspaceId/members',
  });
  return <MembersPage workspaceId={workspaceId} />;
}
