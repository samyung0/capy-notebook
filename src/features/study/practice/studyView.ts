import type { Workspace } from '@/api/types';
import { canManageWorkspaceSettings } from '@/features/workspace/access';

/** The workspace pages that came out of Study (Epo 2026-11-11), each with its
 * own place on the rail: To do (Assignments to a class's staff), Practice,
 * Members, and Study itself, which is its viewer's own marks and mastery
 * (`summary`). */
export type StudyPage = 'members' | 'assignments' | 'practice' | 'summary';

/** Which of those this person has (Epo 2026-11-04, board U3; 2026-11-11). A
 * class's owner and teaching assistants manage: Assignments, Practice's quizzes
 * and topics, and Members with each member's marks; they have no Study, having
 * no marks of their own here. Everyone else has To do, Practice and Study, and
 * a member also Members, without marks (a link or public visitor may not read
 * who the members are); in a personal workspace the owner and editors also add
 * and edit. */
export function studyView(
  workspace: Pick<Workspace, 'kind' | 'role'> | undefined | null
) {
  const canEdit = canManageWorkspaceSettings(workspace);
  const manages = workspace?.kind === 'class' && canEdit;
  const pages: StudyPage[] = manages
    ? ['assignments', 'practice', 'members']
    : workspace?.role
      ? ['assignments', 'practice', 'members', 'summary']
      : ['assignments', 'practice', 'summary'];
  return { canEdit, manages, pages };
}
