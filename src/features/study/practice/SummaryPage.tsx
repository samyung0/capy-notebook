import { useWorkspace } from '@/api/hooks';
import { m } from '@/i18n';
import { MembersMarks } from '../members/MembersPage';
import { PracticePage } from './PracticePage';
import { StudyTabs } from './studyPage';
import { studyView } from './studyView';

/** Study's Overview (`study=summary`). Whoever practises gets Practice's page
 * (Suggested, their topics, every quiz; Epo 2026-11-13); a class's owner and
 * teaching assistants every member's marks. */
export function SummaryPage({
  search,
  workspaceId,
}: {
  search: { member?: string; show?: 'topics' };
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId);
  if (!ws) return null;
  if (!studyView(ws).manages)
    return <PracticePage search={{}} workspaceId={workspaceId} />;
  return (
    <MembersMarks
      header={
        <>
          <h1 className="t-page-title">{m.workspace_tab_study()}</h1>
          <StudyTabs
            staff
            value={search.show === 'topics' ? 'topics' : 'summary'}
          />
        </>
      }
      member={search.member}
      tab={search.show === 'topics' ? 'topics' : 'overview'}
      workspace={ws}
    />
  );
}
