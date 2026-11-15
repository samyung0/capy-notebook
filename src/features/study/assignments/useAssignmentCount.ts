import { useTodo } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { studyView } from '../practice/studyView';
import { todoRows } from './todoRows';

/** The count on the rail's To do or Assignments: for a member what is left to
 * do; for staff the assignments with answers waiting. Read from To do's list
 * (the nav's), which holds both for every class, as the paged assignments
 * list cannot (Epo 2026-11-13). */
export function useAssignmentCount(
  workspace: Pick<Workspace, 'id' | 'kind' | 'role'>
) {
  const { manages } = studyView(workspace);
  const { data } = useTodo({ errorBoundary: false });
  if (!data) return;
  const items =
    data.workspaces.find((w) => w.workspaceId === workspace.id)?.items ?? [];
  const { open, toApprove } = todoRows(items);
  return manages ? toApprove.length : open.length;
}
