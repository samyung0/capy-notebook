import { WorkspaceBankPage } from '@/features/itemBanks/WorkspaceBankPage';
import type { WorkspaceOpenSearch } from '@/features/materials/openItem';
import { HistoryPage } from './HistoryPage';
import { PracticePage } from './PracticePage';
import { SummaryPage } from './SummaryPage';

/** Study's tabs (Overview and Topics, History, Question bank, Practice) as one
 * page loaded together, as the Files page's tabs are (Epo 2026-11-16): a
 * tab switch never waits on code, so the page never blanks between tabs.
 * Editors stay out: each loads only when it renders. */
export function StudyTabsPage({
  page,
  search,
  workspaceId,
}: {
  page: 'summary' | 'history' | 'bank' | 'practice';
  search: WorkspaceOpenSearch;
  workspaceId: string;
}) {
  if (page === 'summary')
    return (
      <SummaryPage
        search={{ member: search.member, show: search.show }}
        workspaceId={workspaceId}
      />
    );
  if (page === 'history') return <HistoryPage workspaceId={workspaceId} />;
  if (page === 'bank') return <WorkspaceBankPage workspaceId={workspaceId} />;
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
