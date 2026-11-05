import { useQueries } from '@tanstack/react-query';
import { useEffect } from 'react';
import { extractionQuery, useExtraction } from '@/api/hooks';
import { isMissing } from '@/api/queryClient';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { m } from '@/i18n';
import {
  extractionFailure,
  extractionNotice,
  runProgress,
  savedCount,
} from './makeQuiz';
import {
  forgetQuizRun,
  type QuizRun,
  quizRunLinks,
  useQuizRuns,
} from './quizRuns';
import { openQuizWait, type QuizWaitState } from './quizWaits';

function QuizRunRow({ run: picked }: { run: QuizRun }) {
  const { data: run, error } = useExtraction(picked.id, {
    errorBoundary: false,
  });
  // A saved run the server no longer has; a passing error keeps it.
  const gone = isMissing(error);
  useEffect(() => {
    if (gone) forgetQuizRun(picked.id);
  }, [gone, picked.id]);
  if (!run) return null;
  const links = quizRunLinks();
  if (run.status === 'done' && run.quizId) {
    const { quizId, workspaceId } = run;
    const notice = extractionNotice(run.report);
    const saved = savedCount(run.report);
    return (
      <li
        className="flex items-center justify-between gap-2 border-divider border-b px-4 py-3 last:border-0"
        data-quiz-run={run.status}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{run.title}</span>
          {notice ? (
            <span className="t-meta text-tint-error-fg">
              {m.make_quiz_panel_incomplete()}
            </span>
          ) : (
            <span className="t-meta text-fg-muted">
              {saved === 1
                ? m.make_quiz_panel_one_question()
                : m.make_quiz_panel_questions({ count: saved })}
            </span>
          )}
        </div>
        <Button
          iconRight="navigationForward"
          onClick={() => links?.openQuiz(workspaceId, quizId)}
          size="sm"
          type="button"
          variant="outline"
        >
          {m.make_quiz_open_quiz()}
        </Button>
      </li>
    );
  }
  if (run.status === 'failed')
    return (
      <li
        className="flex items-center justify-between gap-2 border-divider border-b px-4 py-3 last:border-0"
        data-quiz-run={run.status}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{run.title}</span>
          <span className="t-meta text-tint-error-fg">
            {m.make_quiz_panel_no_charge({
              reason: extractionFailure(run.errorCode),
            })}
          </span>
        </div>
        <Button
          onClick={() => links?.pickAgain(picked)}
          size="sm"
          type="button"
          variant="outline"
        >
          {m.make_quiz_try_again()}
        </Button>
      </li>
    );
  const { label, value } = runProgress(run);
  return (
    <li
      className="flex flex-col gap-2 border-divider border-b px-4 py-3 last:border-0"
      data-quiz-run={run.status}
    >
      <span className="truncate font-medium text-sm">{run.title}</span>
      <div className="flex items-center gap-3">
        <ProgressBar className="flex-1" height={4} value={value} />
        <span className="t-meta shrink-0 text-fg-muted" role="status">
          {label}
        </span>
      </div>
    </li>
  );
}

/** Files read after Continue, with the way back to the dialog's pages; or what failed,
 * with the way back to its files. Reading shows here only for files with no upload row. */
function QuizWaitRow({ state }: { state: QuizWaitState }) {
  const { failures, status, wait } = state;
  return (
    <li
      className="flex flex-col gap-2 border-divider border-b px-4 py-3 last:border-0"
      data-quiz-wait={status}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{wait.title}</span>
          {status === 'ready' && (
            <span className="t-meta text-fg-muted">
              {m.make_quiz_files_ready()}
            </span>
          )}
          {failures.map(({ key, name, reason }) => (
            <span className="t-meta break-words text-tint-error-fg" key={key}>
              {name === wait.title
                ? reason
                : m.source_import_file_error({ name, reason })}
            </span>
          ))}
        </div>
        {status === 'ready' && (
          <Button
            iconRight="navigationForward"
            onClick={() => openQuizWait(state)}
            size="sm"
            type="button"
            variant="outline"
          >
            {m.make_quiz_make_action()}
          </Button>
        )}
        {status === 'failed' && (
          <Button
            onClick={() => openQuizWait(state)}
            size="sm"
            type="button"
            variant="outline"
          >
            {m.make_quiz_try_again()}
          </Button>
        )}
      </div>
      {status === 'reading' && (
        <div className="flex items-center gap-3">
          <ProgressBar className="flex-1" height={4} indeterminate />
          <span className="t-meta shrink-0 text-fg-muted" role="status">
            {m.make_quiz_files_reading()}
          </span>
        </div>
      )}
    </li>
  );
}

/** Make a quiz in the upload panel: a heading, then a row a wait or a run. */
export function QuizRunRows({ waits }: { waits: QuizWaitState[] }) {
  const runs = useQuizRuns((state) => state.runs);
  const done = useQueries({
    // The panel sits over every page: a run it can't read is the row's to deal with.
    queries: runs.map((run) => ({
      ...extractionQuery(run.id),
      meta: { errorBoundary: false },
    })),
  }).filter(({ data }) => data && data.status !== 'running').length;
  if (runs.length + waits.length === 0) return null;
  return (
    <>
      <div className="flex h-9 items-center border-divider border-b px-4 py-2">
        <span className="t-label text-fg-muted">
          {m.make_quiz_panel_heading({
            count: runs.length + waits.length,
            done:
              done + waits.filter((state) => state.status === 'failed').length,
          })}
        </span>
      </div>
      <ul className="max-h-60 overflow-y-auto">
        {waits.map((state) => (
          <QuizWaitRow key={state.wait.id} state={state} />
        ))}
        {runs.map((run) => (
          <QuizRunRow key={run.id} run={run} />
        ))}
      </ul>
    </>
  );
}
