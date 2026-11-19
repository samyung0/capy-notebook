import { type ReactNode, useState } from 'react';
import { useCopyQuizToGradedQuiz, usePractice } from '@/api/hooks';
import type { AssignmentFormReq } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList, Spinner } from '@/components/ui/feedback';
import { SearchInput } from '@/components/ui/SearchInput';
import { userToast } from '@/components/ui/userToast';
import { matchesSearch } from '@/features/workspace/PanelSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { materialIconName } from '@/lib/fileIcons';
import { questionsLabel } from '../practice/practiceText';

/** New graded quiz's Existing quiz tab (Epo 2026-11-16, first of its tabs):
 * one of the workspace's quizzes, as Practice lists them, copied whole into the new
 * graded quiz with its settings in one request
 * (`POST /api/quizzes/{id}/graded-copy`); the original stays as it is. */
export function useExistingQuizPicker({
  gradedQuiz,
  onMade,
  workspaceId,
}: {
  /** The graded quiz's settings; none where the tab isn't offered. */
  gradedQuiz?: AssignmentFormReq;
  onMade: (assignmentId: string) => void;
  workspaceId: string;
}) {
  const { data, error, isError, refetch } = usePractice(workspaceId, {
    enabled: !!gradedQuiz,
    errorBoundary: false,
  });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string>();
  const { isPending: copying, mutate: copy } =
    useCopyQuizToGradedQuiz(workspaceId);
  // The workspace's own: a practice quiz made only for oneself has none.
  const quizzes = (data?.items ?? []).filter(
    (row) => row.kind === 'quiz' && !row.onlyYou
  );
  const shown = quizzes.filter((row) => matchesSearch(row.title, query));
  const chosen = quizzes.find((row) => row.id === picked);

  let list: ReactNode;
  if (isError)
    list = (
      <ErrorState
        className="h-auto py-16"
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
        title={m.assignment_existing_load_failed()}
        variant="panel"
      />
    );
  else if (!data) list = <SkeletonList count={6} rowHeight={52} />;
  else if (shown.length === 0)
    list = (
      <p className="t-meta mt-3 text-fg-muted">
        {query ? m.common_no_matches() : m.common_nothing_yet()}
      </p>
    );
  else
    list = (
      <div aria-label={m.assignment_tab_existing()} role="radiogroup">
        {shown.map((row) => {
          const on = row.id === picked;
          return (
            <div
              aria-checked={on}
              className="flex cursor-pointer items-start gap-3 border-divider border-b px-1 py-3 outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg"
              key={row.id}
              onClick={() => setPicked(row.id)}
              onKeyDown={(event) => {
                if (event.key !== ' ' && event.key !== 'Enter') return;
                event.preventDefault();
                setPicked(row.id);
              }}
              role="radio"
              tabIndex={0}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 size-4.5 shrink-0 rounded-full border-[1.5px] border-fg-muted',
                  on && 'border-[5px] border-action'
                )}
              />
              <FileIcon
                className="mt-px size-4.5 shrink-0"
                name={materialIconName('quiz')}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold">{row.title}</span>
                <span className="t-meta mt-0.5 text-fg-secondary">
                  {questionsLabel(row.size)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    );

  const body = (
    <>
      <SearchInput
        aria-label={m.assignment_existing_search()}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={m.assignment_existing_search()}
        value={query}
        wrapperClassName="h-8 min-w-0"
      />
      {/* Fills the dialog's one height, as the bank's list does. */}
      <div className="mt-2 min-h-60 flex-1 overflow-y-auto">{list}</div>
    </>
  );
  const note = chosen ? (
    <span className="font-semibold text-fg">{questionsLabel(chosen.size)}</span>
  ) : null;
  const action = (
    <Button
      disabled={copying || !chosen}
      onClick={() =>
        chosen &&
        gradedQuiz &&
        copy(
          {
            // An untitled graded quiz is named after its quiz.
            gradedQuiz: {
              ...gradedQuiz,
              title: gradedQuiz.title || chosen.title,
            },
            quizId: chosen.id,
          },
          {
            onError: (error) =>
              userToast({
                title: errorCopy(error, m.assignment_save_failed()),
                variant: 'error',
              }),
            onSuccess: (created) => onMade(created.id),
          }
        )
      }
      type="button"
    >
      {copying ? <Spinner /> : m.assignment_create()}
    </Button>
  );
  return { action, body, note };
}
