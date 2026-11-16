import type { Assignment } from '@/api/types';
import type { AssignmentsSearch } from './AssignmentsPage';

/** Where an assignment's pages open: its workspace's own page, or for a task
 * with no workspace (Epo 2026-11-11) To do's, which hosts the same ones. */
export function assignmentPage(
  a: Pick<Assignment, 'id' | 'workspaceId'>,
  search: Omit<AssignmentsSearch, 'assignment' | 'newFromQuiz'> = {}
) {
  const opened = {
    ...search,
    assignment: a.id,
    study: 'assignments' as const,
  };
  return a.workspaceId
    ? {
        params: { workspaceId: a.workspaceId },
        search: opened,
        to: '/workspaces/$workspaceId' as const,
      }
    : { search: opened, to: '/todo/task' as const };
}

/** Where a task's file opens: in its workspace, or on its own page with none. */
export function fileLink(file: Assignment['files'][number]) {
  if (file.workspaceId)
    return {
      params: { workspaceId: file.workspaceId },
      search: file.fileId
        ? { file: file.fileId }
        : { material: file.materialId },
      to: '/workspaces/$workspaceId' as const,
    };
  return file.fileId
    ? { params: { fileId: file.fileId }, to: '/files/$fileId' as const }
    : {
        params: { materialId: file.materialId ?? '' },
        to: '/materials/$materialId' as const,
      };
}
