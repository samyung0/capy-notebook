import { useNavigate } from '@tanstack/react-router';
import { useAssignments } from '@/api/hooks';
import type { Assignment } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { ListRow, Td, Th } from '../practice/studyPage';
import { assignmentsLink } from '../studyRoutes';
import { dateLabel } from './assignmentText';
import { submissionsText, WorkChip } from './todoParts';

/** What waits on staff for one assignment (Epo 2026-11-26): AI marks to
 * approve, answers to mark, submissions to grade, or grades not released. */
export function pendingText(a: Assignment) {
  const manage = a.manage;
  if (!manage) return '';
  // Under AI marking with approval, what the AI marked waits for approval and
  // what it could not waits to be marked; otherwise every waiting answer
  // waits to be marked.
  const approve =
    manage.marking === 'ai_approve' ? manage.toApprove - manage.notGraded : 0;
  const mark = manage.toApprove - approve;
  const parts = [
    approve > 0 &&
      (approve === 1
        ? m.to_grade_ai_marks_one()
        : m.to_grade_ai_marks({ count: approve })),
    mark > 0 &&
      (mark === 1
        ? m.to_grade_answers_one()
        : m.to_grade_answers({ count: mark })),
    manage.toGrade > 0 && submissionsText(manage.toGrade),
    manage.toRelease && m.to_grade_release(),
  ].filter(Boolean);
  return parts.join(' · ');
}

/** A quiz is named by its chip, as To do names it; anything else by its
 * title. */
function GradeTitle({ a }: { a: Assignment }) {
  if (a.kind === 'marked') return <WorkChip title={a.title} />;
  return <span className="block truncate">{a.title}</span>;
}

/**
 * A class's To grade (Epo 2026-11-26, mock JUgZAmfV9KSiZb4JV8ZqLn A): its
 * Dashboard's first section for its owner and editors, in place of To do.
 * One row per assignment with something waiting on staff, open or closed, on
 * the Assignments page's table (`Th`, `Td`) and its narrow rows (`ListRow`):
 * what is pending, how many submitted, the due date. The row itself opens
 * the assignment's Grading tab, and leaves once nothing waits.
 */
export function ToGradeSection({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data, error, isPending, refetch } = useAssignments(
    workspaceId,
    { closed: true, done: true, pending: true, topics: [] },
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isPending);
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  const open = (a: Assignment) =>
    void navigate(
      assignmentsLink(workspaceId, { assignment: a.id, tab: 'grading' })
    );
  const submitted = (a: Assignment) =>
    m.to_grade_submitted({
      done: a.manage?.done ?? 0,
      total: a.manage?.assigned ?? 0,
    });
  // The date alone, the year with it, whether it closed or not.
  const due = (a: Assignment) => (a.dueAt ? dateLabel(a.dueAt) : '–');
  // Only grades to release is no grading left: it reads quieter.
  const quiet = (a: Assignment) => !a.manage?.toApprove && !a.manage?.toGrade;
  return (
    <section className="@container flex flex-col">
      <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
        <h2 className="t-subtitle">{m.dashboard_to_grade()}</h2>
        <Button
          iconRight="navigationForward"
          onClick={() => void navigate(assignmentsLink(workspaceId))}
          size="sm"
          type="button"
          variant="outline"
        >
          {m.dashboard_all_assignments()}
        </Button>
      </div>
      {isPending && <SkeletonList count={3} rowHeight={40} />}
      {!data && error && (
        <InlineErrorState
          className="py-6"
          errorId={unexpectedErrorId(error)}
          message={m.assignment_load_failed()}
          onRetry={() => void refetch()}
        />
      )}
      {data && rows.length === 0 && (
        <p className="t-meta border-divider border-y py-3 text-fg-muted">
          {m.to_grade_none()}
        </p>
      )}
      {data && rows.length > 0 && (
        <div ref={revealRef}>
          <table className="@4xl:table hidden w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <Th>{m.assignment_col_assignment()}</Th>
                <Th>{m.assignment_col_pending()}</Th>
                <Th>{m.assignment_col_submitted()}</Th>
                <Th>{m.assignment_col_due()}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr
                  className="cursor-pointer hover:[&>td]:bg-surface-hover-bg"
                  key={a.id}
                  onClick={() => open(a)}
                >
                  <Td className="w-full max-w-0">
                    <GradeTitle a={a} />
                  </Td>
                  <Td
                    className={cn(
                      'font-semibold',
                      quiet(a) ? 'text-fg-muted' : 'text-tint-warning-fg'
                    )}
                  >
                    {pendingText(a)}
                  </Td>
                  <Td muted>{submitted(a)}</Td>
                  <Td muted>{due(a)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Phones and narrow panes: two lines a row. */}
          <ul className="@4xl:hidden">
            {rows.map((a) => (
              <ListRow key={a.id} onOpen={() => open(a)}>
                {/* items-start: a quiz's chip hugs its title, as on To do. */}
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <GradeTitle a={a} />
                  <span className="t-meta max-w-full truncate text-fg-muted">
                    <span
                      className={cn(
                        'font-semibold',
                        !quiet(a) && 'text-tint-warning-fg'
                      )}
                    >
                      {pendingText(a)}
                    </span>
                    {` · ${submitted(a)} · ${due(a)}`}
                  </span>
                </div>
              </ListRow>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
