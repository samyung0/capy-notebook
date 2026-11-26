import type { ReviewMode } from '@/api/types';
import type { WorkspaceOpenSearch } from '@/features/materials/openItem';
import type { StudyPage } from './practice/studyView';
import { type HistorySearch, parseHistorySearch } from './reviewSearch';

/* The workspace pages that came out of Study are routes under the workspace's
 * (Epo 2026-11-18): `assignments`, `members` and `study/<tab>`, whose code the
 * router loads before it leaves the page on screen. Their search keys are
 * theirs alone; each parser names every key, as the router keeps raw keys a
 * parser leaves out. */

/** Study's tabs, each `study/<tab>`. */
export type StudyTab = 'summary' | 'topics' | 'practice' | 'bank' | 'history';

/** A report's tab in the URL: a graded quiz's Questions, Responses, Grading
 * (grading and approving its answers) and Settings; an Assignment's Content,
 * Responses, Grading (one graded on points or taking files) and Settings (Epo
 * 2026-11-21). */
export type ReportTab =
  | 'questions'
  | 'content'
  | 'responses'
  | 'grading'
  | 'settings';

/** The Assignments page's URL, `assignments`. `assignment` opens
 * one: its report for a class's owner and teaching assistants (unless `own`, the
 * page of one they gave themselves with "You"), its page for a member.
 * `attempt` opens a try: a
 * running one, or results, a member's for staff. `tab`, `by`, `question` and
 * `member` are a report's view (todo-study-tracking.md §9, Links), Grading's
 * `member` and `work` the member and hand-in file it shows (Epo 2026-11-19;
 * not `file`, the workspace's own file key);
 * `by` is Responses' By question (By member without it). */
export type AssignmentsSearch = {
  assignment?: string;
  attempt?: string;
  /** Grading's full screen (Epo 2026-11-19): its lists and the file or answer. */
  fullscreen?: true;
  member?: string;
  own?: true;
  question?: string;
  by?: 'question';
  /** Beside `attempt` and `member`: the profile's Topics tab to return to. */
  show?: 'topics';
  tab?: ReportTab;
  work?: string;
};

/** The Practice page's URL, `study/practice`: a topic session to start
 * (group, topic, a suggestion's mode) or a finished one's result. */
export type PracticeSearch = {
  group?: 'topic' | 'others' | 'workspace';
  topicId?: string;
  reviewMode?: ReviewMode;
  review?: string;
};

const STUDY_TABS = [
  'summary',
  'topics',
  'practice',
  'bank',
  'history',
] as const satisfies readonly StudyTab[];

export function isStudyTab(value: string): value is StudyTab {
  return (STUDY_TABS as readonly string[]).includes(value);
}

/** The page a Study tab is: Topics is the staff's Overview on members ×
 * topics. */
export const studyTabPage = (tab: StudyTab): StudyPage =>
  tab === 'topics' ? 'summary' : tab;

const text = (value: unknown) =>
  typeof value === 'string' && value ? value : undefined;

const REPORT_TABS = [
  'questions',
  'content',
  'responses',
  'grading',
  'settings',
] as const satisfies readonly ReportTab[];

/** Assignments, one assignment (its report's view), or a try at one. Unknown
 * tabs clear; ids are the page's to answer. */
export function parseAssignmentsSearch(
  search: Record<string, unknown>
): AssignmentsSearch {
  const none: AssignmentsSearch = {
    assignment: undefined,
    attempt: undefined,
    by: undefined,
    fullscreen: undefined,
    member: undefined,
    own: undefined,
    question: undefined,
    show: undefined,
    tab: undefined,
    work: undefined,
  };
  const assignment = text(search.assignment);
  if (!assignment) return none;
  const attempt = text(search.attempt);
  if (attempt) {
    // Opened from a member's profile: its back link returns there.
    const member = text(search.member);
    return {
      ...none,
      assignment,
      attempt,
      member,
      show: member && search.show === 'topics' ? 'topics' : undefined,
    };
  }
  const tab = REPORT_TABS.find((t) => t === search.tab);
  return {
    ...none,
    assignment,
    by:
      tab === 'responses' && search.by === 'question' ? 'question' : undefined,
    // Grading's and the Questions editor's full screen (Epo 2026-11-19), and
    // By question's (Epo 2026-11-22); no tab is the first, a graded quiz's
    // Questions.
    fullscreen:
      (tab === 'grading' ||
        tab === 'questions' ||
        tab === undefined ||
        (tab === 'responses' && search.by === 'question')) &&
      (search.fullscreen === true || search.fullscreen === 'true')
        ? true
        : undefined,
    // The member Grading shows; a graded quiz's also keeps its question.
    member: tab === 'grading' ? text(search.member) : undefined,
    own: search.own === true || search.own === 'true' ? true : undefined,
    question: tab === 'grading' ? text(search.question) : undefined,
    tab,
    work: tab === 'grading' ? text(search.work) : undefined,
  };
}

const GROUPS = ['topic', 'others', 'workspace'] as const;
const MODES: readonly ReviewMode[] = ['tricky', 'fading', 'learned'];

/** Practice: a topic session to start on it, or a session's result. */
function parsePracticeSearch(search: Record<string, unknown>): PracticeSearch {
  const none: PracticeSearch = {
    group: undefined,
    review: undefined,
    reviewMode: undefined,
    topicId: undefined,
  };
  const review = text(search.review);
  if (review) return { ...none, review };
  const group = GROUPS.find((g) => g === search.group);
  const topicId = text(search.topicId);
  if (!group || (group === 'topic' && !topicId)) return none;
  return {
    ...none,
    group,
    reviewMode: MODES.find((md) => md === search.reviewMode),
    topicId: group === 'topic' ? topicId : undefined,
  };
}

/** Study's tabs share one route, so their keys share one search: a staff
 * member's profile on Overview or Topics (`member`), Practice's session or
 * result, History's sort and filters. On Overview `topic` opens a topic's
 * questions (a topic id, or `others` for Other files) and `wrong` Frequently
 * wrong's, beside `member` for a class's staff (Epo 2026-11-22). */
export type StudySearch = PracticeSearch &
  HistorySearch & {
    member?: string;
    topic?: string;
    wrong?: true;
  };

export function parseStudySearch(search: Record<string, unknown>): StudySearch {
  return {
    dir: undefined,
    kind: undefined,
    sort: undefined,
    status: undefined,
    workspace: undefined,
    ...parseHistorySearch(search),
    ...parsePracticeSearch(search),
    member: text(search.member),
    topic: text(search.topic),
    wrong: search.wrong === true || search.wrong === 'true' ? true : undefined,
  };
}

/** Links to the pages, from anywhere. */
export const assignmentsLink = (
  workspaceId: string,
  search: AssignmentsSearch = {}
) => ({
  params: { workspaceId },
  search,
  to: '/workspaces/$workspaceId/assignments' as const,
});

/** A member's own try at an assignment, taken and read on a page of its own
 * outside the workspace (Epo 2026-11-25): it loads the attempt alone, not the
 * workspace's lists. Staff read a member's in the workspace (`attempt`). */
export const attemptLink = (attemptId: string) => ({
  params: { attemptId },
  to: '/attempts/$attemptId' as const,
});

export const membersLink = (workspaceId: string) => ({
  params: { workspaceId },
  to: '/workspaces/$workspaceId/members' as const,
});

export const studyLink = (
  workspaceId: string,
  tab: StudyTab,
  // `make` opens Make a quiz over the tab (Practice's Add practice).
  search: StudySearch & Pick<WorkspaceOpenSearch, 'make'> = {}
) => ({
  params: { tab, workspaceId },
  search,
  to: '/workspaces/$workspaceId/study/$tab' as const,
});
