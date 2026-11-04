import type { Workspace } from '@/api/types';
import { canManageWorkspaceSettings } from '@/features/workspace/access';

/** Study's pages. Only Practice is built; the others wait for their own
 * branches (Members, Assignments, My results). */
export type StudyPage = 'members' | 'assignments' | 'practice' | 'results';

/** What Study gives this person (Epo 2026-11-04, board U3). In a class the
 * owner and teaching assistants manage (Members, Assignments, Practice's
 * quizzes and topics) and members practise (My results, Assignments, Practice).
 * In a personal workspace everyone practises (My results, Practice), and the
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
      ? ['results', 'assignments', 'practice']
      : ['results', 'practice'];
  return { canEdit, manages, pages };
}
