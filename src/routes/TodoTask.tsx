import { Navigate, useSearch } from '@tanstack/react-router';
import { PagePanel } from '@/components/app/layout';
import { AssignmentAttemptPage } from '@/features/study/assignments/AssignmentAttemptPage';
import { AssignmentDetail } from '@/features/study/assignments/AssignmentsPage';

/** The pages of a task with no workspace (Epo 2026-11-11): its quiz, its
 * results and its report are an assignment's own, which a workspace shows
 * under `study=assignments`; with no workspace To do holds them. Their links
 * stay on this page (`to: '.'`), and one that names no task is To do's. */
export default function TodoTask() {
  const search = useSearch({ from: '/auth-shell/todo/task' });
  if (!search.assignment) return <Navigate replace to="/todo" />;
  return (
    <PagePanel fill>
      {search.attempt ? (
        <AssignmentAttemptPage
          attemptId={search.attempt}
          key={search.attempt}
          workspaceId=""
        />
      ) : (
        <AssignmentDetail
          id={search.assignment}
          key={search.assignment}
          search={search}
        />
      )}
    </PagePanel>
  );
}
