import type { QueryClient } from '@tanstack/react-query';
import {
  type AssignmentListParams,
  assignmentQuery,
  assignmentsQuery,
  continueQuery,
  historyQuery,
  membersProgressQuery,
  practiceQuery,
  studyQuestionsQuery,
  studyTopicsQuery,
  todoQuery,
  workspaceDashboardQuery,
  workspaceInvitesQuery,
  workspaceMembersQuery,
  workspaceQuery,
  workspaceRecentQuery,
} from '@/api/hooks';
import { itemBankQuestionsQuery, itemBankTagsQuery } from '@/api/itemBanks';
import type { Workspace } from '@/api/types';
import type { WorkspaceOpenSearch } from '@/features/materials/openItem';
import { studyView } from '@/features/study/practice/studyView';
import { historyParams } from '@/features/study/reviewSearch';
import type {
  AssignmentsSearch,
  StudySearch,
  StudyTab,
} from '@/features/study/studyRoutes';

/* The reads a workspace page opens with, started by its route's loader (a
 * hovered link's preload included) or the rail's hover, so they go out in one
 * wave beside the page's code (Q906, Q907). They only prime the cache: each
 * page reads through its own hooks. Imported by the router, so it stays free
 * of page code. */

/** For a read whose page shows its own error: a prefetch failing before the
 * page mounts keeps that policy, as the page's hook hands the query its meta
 * only when it fetches again. */
const optional = { meta: { errorBoundary: false } } as const;

/** Runs once the workspace's read is in: at once from the cache (a hover on
 * the rail), else when the workspace route's own read lands. A failed read is
 * the workspace page's to show. */
function withWorkspace(
  qc: QueryClient,
  workspaceId: string,
  then: (workspace: Workspace) => void
) {
  qc.ensureQueryData(workspaceQuery(workspaceId)).then(then, () => undefined);
}

/** The workspace as the cache already holds it before its read answers: its
 * own read kept from an earlier visit, else a list it was picked from. */
function cachedWorkspace(qc: QueryClient, workspaceId: string) {
  const own = qc.getQueryData(workspaceQuery(workspaceId).queryKey);
  if (own) return own;
  for (const [, list] of qc.getQueriesData<Workspace[]>({
    queryKey: ['workspaces'],
  })) {
    const listed = Array.isArray(list)
      ? list.find((workspace) => workspace.id === workspaceId)
      : undefined;
    if (listed) return listed;
  }
}

/** A class's To grade, its staff's first Dashboard section (ToGradeSection):
 * every assignment with something waiting on staff, open or closed. */
export const TO_GRADE: AssignmentListParams = {
  closed: true,
  done: true,
  pending: true,
  topics: [],
};

/** Whether a workspace URL opens its Dashboard: no workspace page under it
 * (`/workspaces/<id>` alone), no open item and no other view. */
export const opensDashboard = (
  pathname: string,
  search: Pick<WorkspaceOpenSearch, 'file' | 'material' | 'view'>
) =>
  pathname.split('/').filter(Boolean).length === 2 &&
  !(search.file || search.material || search.view);

/** The Dashboard's: its head and Activity, Recent files, To do and Continue,
 * and To grade when the cache already says the person is a class's staff;
 * otherwise To grade waits for the workspace's read and the page (Q911). */
export function prefetchDashboard(qc: QueryClient, workspaceId: string) {
  qc.prefetchQuery(workspaceDashboardQuery(workspaceId));
  qc.prefetchQuery(workspaceRecentQuery(workspaceId));
  qc.prefetchQuery({ ...todoQuery(), ...optional });
  qc.prefetchQuery(continueQuery(workspaceId));
  if (studyView(cachedWorkspace(qc, workspaceId)).manages)
    qc.prefetchInfiniteQuery({
      ...assignmentsQuery(workspaceId, TO_GRADE),
      ...optional,
    });
}

/** Study at `tab`. Overview and Topics are every member's marks for a class's
 * owner and teaching assistants, else Practice's page with the person's
 * topics and Frequently wrong, which no longer waits for the other two;
 * Practice; History, this workspace's rows; the Question bank. */
export function prefetchStudy(
  qc: QueryClient,
  workspaceId: string,
  tab: StudyTab,
  search: StudySearch
) {
  if (tab === 'history') {
    qc.prefetchInfiniteQuery(
      historyQuery({ ...historyParams(search), workspaceIds: [workspaceId] })
    );
    return;
  }
  if (tab === 'bank') {
    qc.prefetchInfiniteQuery({
      ...itemBankQuestionsQuery(workspaceId),
      ...optional,
    });
    qc.prefetchQuery(itemBankTagsQuery(workspaceId));
    return;
  }
  withWorkspace(qc, workspaceId, (workspace) => {
    const { manages } = studyView(workspace);
    if (manages && tab !== 'practice') {
      qc.prefetchQuery({ ...membersProgressQuery(workspaceId), ...optional });
      return;
    }
    qc.prefetchQuery({ ...practiceQuery(workspaceId), ...optional });
    if (manages) return;
    qc.prefetchQuery({ ...studyTopicsQuery(workspaceId), ...optional });
    qc.prefetchQuery({
      ...studyQuestionsQuery(workspaceId, { list: 'wrong' }),
      ...optional,
    });
  });
}

/** Members: the people, the pending invites for whoever manages them, and a
 * class staff's member lines (storage full). */
export function prefetchMembers(qc: QueryClient, workspaceId: string) {
  qc.prefetchQuery({ ...workspaceMembersQuery(workspaceId), ...optional });
  withWorkspace(qc, workspaceId, (workspace) => {
    if (workspace.capabilities.canManageMembers)
      qc.prefetchQuery({ ...workspaceInvitesQuery(workspaceId), ...optional });
    if (studyView(workspace).manages)
      qc.prefetchQuery({ ...membersProgressQuery(workspaceId), ...optional });
  });
}

/** The Assignments table's first sort: Posted, newest first (AssignmentsPage
 * starts from it, so the prefetch asks what the page will). */
export const ASSIGNMENTS_FIRST_SORT = {
  ascending: false,
  by: 'posted',
} as const;

/** The Assignments page's first ask (AssignmentList): open ones and done ones,
 * Posted newest first. */
const ASSIGNMENTS_FIRST: AssignmentListParams = {
  closed: false,
  done: true,
  sort: ASSIGNMENTS_FIRST_SORT,
  topics: [],
};

/** Assignments: the list, or the one assignment its URL opens. A try's page
 * reads its attempt afresh on every open, so nothing is started for it. */
export function prefetchAssignments(
  qc: QueryClient,
  workspaceId: string,
  search: Pick<AssignmentsSearch, 'assignment' | 'attempt'>
) {
  if (search.attempt) return;
  if (search.assignment)
    qc.prefetchQuery({ ...assignmentQuery(search.assignment), ...optional });
  else
    qc.prefetchInfiniteQuery({
      ...assignmentsQuery(workspaceId, ASSIGNMENTS_FIRST),
      ...optional,
    });
}
