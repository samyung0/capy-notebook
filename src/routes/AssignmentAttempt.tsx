import { useParams } from '@tanstack/react-router';
import { PagePanel } from '@/components/app/layout';
import { AssignmentAttemptPage } from '@/features/study/assignments/AssignmentAttemptPage';

/** `/attempts/$attemptId`: a member's try at an assignment on its own page
 * (Epo 2026-11-25), outside the workspace so it loads the attempt alone. */
export default function AssignmentAttempt() {
  const { attemptId } = useParams({ from: '/auth-shell/attempts/$attemptId' });
  return (
    <PagePanel fill phoneRow={false}>
      <AssignmentAttemptPage attemptId={attemptId} key={attemptId} />
    </PagePanel>
  );
}
