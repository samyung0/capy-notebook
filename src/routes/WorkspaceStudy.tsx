import { useParams, useSearch } from '@tanstack/react-router';
import { StudyTabsPage } from '@/features/study/practice/StudyTabsPage';

const from = '/auth-shell/workspaces/$workspaceId/study/$tab';

/** The workspace's Study, at one of its tabs, in its centre. */
export default function WorkspaceStudy() {
  const { tab, workspaceId } = useParams({ from });
  const search = useSearch({ from });
  return <StudyTabsPage search={search} tab={tab} workspaceId={workspaceId} />;
}
