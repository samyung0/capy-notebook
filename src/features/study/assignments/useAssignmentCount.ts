import { useAssignments } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { studyView } from '../practice/studyView';

/** The count on the rail's To do or Assignments: for a member what is left to
 * do; for staff the assignments with answers waiting. */
export function useAssignmentCount(
  workspace: Pick<Workspace, 'id' | 'kind' | 'role'>
) {
  const { manages } = studyView(workspace);
  const { data } = useAssignments(workspace.id, { errorBoundary: false });
  return data?.items.filter((a) =>
    manages ? (a.manage?.toApprove ?? 0) > 0 : !a.mine?.done && !a.closedAt
  ).length;
}
