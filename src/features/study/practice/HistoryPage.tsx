import { m } from '@/i18n';
import { StudyHistory } from '../StudyHistory';
import { StudyTabs } from './studyPage';

/** Study's History tab in a workspace (Epo 2026-11-13; Practice's tab until
 * then): the account's History table, this workspace's rows only. */
export function HistoryPage({ workspaceId }: { workspaceId: string }) {
  return (
    // One column leaves room under the page for the floating chat button.
    <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-24 lg:pb-10">
      {/* 16px down to the toolbar, as on the account's History. */}
      <div className="page-px pt-5 pb-2 lg:pt-7">
        <h1 className="t-page-title">{m.workspace_tab_study()}</h1>
        <StudyTabs staff={false} value="history" />
      </div>
      <StudyHistory workspaceId={workspaceId} />
    </div>
  );
}
