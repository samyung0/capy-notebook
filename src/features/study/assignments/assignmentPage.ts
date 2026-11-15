import type { Assignment } from '@/api/types';
import type { AssignmentsSearch, ReportTab } from './AssignmentsPage';

type ReportKind = Pick<Assignment, 'draft' | 'kind'>;

/** A report's tabs (Epo 2026-11-15): a graded quiz's Questions | Responses |
 * Settings, a draft's Questions | Settings; a task's Members | Settings |
 * Preview, a draft's Settings | Preview. The first is the tab with no `tab`. */
export function reportTabs({ draft, kind }: ReportKind): ReportTab[] {
  if (kind === 'marked')
    return draft
      ? ['questions', 'settings']
      : ['questions', 'responses', 'settings'];
  return draft ? ['settings', 'preview'] : ['members', 'settings', 'preview'];
}

/** The tab a report's URL shows, links from before Responses included: a
 * graded quiz's `members` is Responses By member, `approve` Responses' Approve
 * AI grades and `preview` (now a header button) its first tab. */
export function reportView(
  assignment: ReportKind,
  { by, tab }: Pick<AssignmentsSearch, 'by' | 'tab'>
) {
  const tabs = reportTabs(assignment);
  const responses = tabs.includes('responses');
  const approving = responses && tab === 'approve';
  const shown: ReportTab =
    approving || (responses && tab === 'members')
      ? 'responses'
      : tab && tabs.includes(tab)
        ? tab
        : tabs[0];
  return {
    approving,
    byQuestion: shown === 'responses' && !approving && by === 'question',
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
