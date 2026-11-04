import type { Workspace } from '@/api/types';
import { canManageWorkspaceSettings } from '@/features/workspace/access';

/** Study's pages. Only Practice is built; the others wait for their own
 * branches (Members, Assignments, Summary). */
export type StudyPage = 'members' | 'assignments' | 'practice' | 'summary';

/** What Study gives this person (Epo 2026-11-04, board U3). In a class the
 * owner and teaching assistants manage (Members, Assignments, Practice's
 * quizzes and topics) and members practise (Summary, Assignments, Practice).
 * In a personal workspace everyone practises (Summary, Practice), and the
 * owner and editors also add and edit. */
export function studyView(
  workspace: Pick<Workspace, 'kind' | 'role'> | undefined | null
) {
  const canEdit = canManageWorkspaceSettings(workspace);
  const isClass = workspace?.kind === 'class';
  const manages = isClass && canEdit;
  const pages: StudyPage[] = manages
    ? ['members', 'assignments', 'practice']
    : isClass
      ? ['summary', 'assignments', 'practice']
      : ['summary', 'practice'];
  return { canEdit, manages, pages };
}
