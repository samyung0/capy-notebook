import { useMembersProgress } from '@/api/hooks';
import type { MembersProgress, Workspace } from '@/api/types';
import { studyView } from '../practice/studyView';

/** The members whose storage is full: Manage marks their rows, and its tab and
 * the rail's Members carry a dot while there are any. */
export const storageFullOf = (data: MembersProgress | undefined) =>
  new Set(data?.members.filter((m) => m.storageFull).map((m) => m.userId));

/** Whether anything on Members → Manage waits on a class's staff. Only staff
 * read the members' progress, so no one else asks. */
export function useMembersNeedAction(
  workspace: Pick<Workspace, 'id' | 'kind' | 'role'>
) {
  const { manages } = studyView(workspace);
  const { data } = useMembersProgress(
    workspace.id,
    { errorBoundary: false },
    manages
  );
  return storageFullOf(data).size > 0;
}
