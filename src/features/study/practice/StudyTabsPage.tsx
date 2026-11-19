import { WorkspaceBankPage } from '@/features/itemBanks/WorkspaceBankPage';
import type { StudySearch, StudyTab } from '../studyRoutes';
import { HistoryPage } from './HistoryPage';
import { PracticePage } from './PracticePage';
import { SummaryPage } from './SummaryPage';

/** Study's tabs (Overview and Topics, History, Question bank, Practice) as one
 * page loaded together, as the Files page's tabs are (Epo 2026-11-16): a
 * tab switch never waits on code, so the page never blanks between tabs.
 * Editors stay out: each loads only when it renders. */
export function StudyTabsPage({
  search,
  tab,
  workspaceId,
}: {
  search: StudySearch;
  tab: StudyTab;
  workspaceId: string;
}) {
  if (tab === 'summary' || tab === 'topics')
    return (
      <SummaryPage
        search={{
          member: search.member,
          show: tab === 'topics' ? 'topics' : undefined,
        }}
        workspaceId={workspaceId}
      />
    );
  if (tab === 'history') return <HistoryPage workspaceId={workspaceId} />;
  if (tab === 'bank') return <WorkspaceBankPage workspaceId={workspaceId} />;
  return (
    <PracticePage
      search={{
        group: search.group,
        review: search.review,
        reviewMode: search.reviewMode,
        topicId: search.topicId,
      }}
      workspaceId={workspaceId}
    />
  );
}
