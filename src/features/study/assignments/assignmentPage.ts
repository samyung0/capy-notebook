import type { Assignment } from '@/api/types';
import type { AssignmentsSearch, ReportTab } from '../studyRoutes';

type ReportKind = Pick<Assignment, 'allowUploads' | 'draft' | 'kind'>;

/** A report's tabs (Epo 2026-11-15): a graded quiz's Questions | Responses |
 * Grading | Settings (Epo 2026-11-19), a draft's Questions | Settings; an
 * Assignment's Content | Responses | Settings (Epo 2026-11-21), with Grading
 * before Settings when it takes files (Epo 2026-11-19; its points go with
 * them, 2026-11-21), a draft's Settings alone (no Preview: there is nothing to
 * preview). The first is the tab with no `tab`. */
export function reportTabs({
  allowUploads,
  draft,
  kind,
}: ReportKind): ReportTab[] {
  if (kind === 'marked')
    return draft
      ? ['questions', 'settings']
      : ['questions', 'responses', 'grading', 'settings'];
  if (draft) return ['settings'];
  return allowUploads
    ? ['content', 'responses', 'grading', 'settings']
    : ['content', 'responses', 'settings'];
}

/** The tab a report's URL shows, its first when the URL names none of its. */
export function reportView(
  assignment: ReportKind,
  { by, tab }: Pick<AssignmentsSearch, 'by' | 'tab'>
) {
  const tabs = reportTabs(assignment);
  const shown: ReportTab = tab && tabs.includes(tab) ? tab : tabs[0];
  return {
    byQuestion: shown === 'responses' && by === 'question',
    tab: shown,
    tabs,
  };
}

/** Where an assignment's file opens: in its class's workspace. */
export function fileLink(
  workspaceId: string,
  file: Pick<Assignment['files'][number], 'fileId' | 'materialId'>
) {
  return {
    params: { workspaceId },
    search: file.fileId ? { file: file.fileId } : { material: file.materialId },
    to: '/workspaces/$workspaceId' as const,
  };
}
