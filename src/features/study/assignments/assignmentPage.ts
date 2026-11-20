import type { Assignment } from '@/api/types';
import {
  type AssignmentsSearch,
  assignmentsLink,
  type ReportTab,
} from '../studyRoutes';

type ReportKind = Pick<Assignment, 'allowUploads' | 'draft' | 'kind'> &
  Partial<Pick<Assignment, 'points'>>;

/** A report's tabs (Epo 2026-11-15): a graded quiz's Questions | Responses |
 * Grading | Settings (Epo 2026-11-19), a draft's Questions | Settings; a task's Members | Settings, with
 * Grading between when it takes files or is graded on points (Epo
 * 2026-11-19), a draft's Settings alone (no Preview: there is nothing to
 * preview). The first is the tab with no `tab`. */
export function reportTabs({
  allowUploads,
  draft,
  kind,
  points,
}: ReportKind): ReportTab[] {
  if (kind === 'marked')
    return draft
      ? ['questions', 'settings']
      : ['questions', 'responses', 'grading', 'settings'];
  if (draft) return ['settings'];
  return allowUploads || points !== undefined
    ? ['members', 'grading', 'settings']
    : ['members', 'settings'];
}

/** The tab a report's URL shows: a graded quiz's `members` is Responses By
 * member. */
export function reportView(
  assignment: ReportKind,
  { by, tab }: Pick<AssignmentsSearch, 'by' | 'tab'>
) {
  const tabs = reportTabs(assignment);
  const responses = tabs.includes('responses');
  const shown: ReportTab =
    responses && tab === 'members'
      ? 'responses'
      : tab && tabs.includes(tab)
        ? tab
        : tabs[0];
  return {
    byQuestion: shown === 'responses' && by === 'question',
    tab: shown,
    tabs,
  };
}

/** Where an assignment's pages open: its workspace's own page, or for a task
 * with no workspace (Epo 2026-11-11) To do's, which hosts the same ones. */
export function assignmentPage(
  a: Pick<Assignment, 'id' | 'workspaceId'>,
  search: Omit<AssignmentsSearch, 'assignment'> = {}
) {
  const opened = { ...search, assignment: a.id };
  return a.workspaceId
    ? assignmentsLink(a.workspaceId, opened)
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
