import { useQueries } from '@tanstack/react-query';
import { extractionQuery, useExtraction } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { m } from '@/i18n';
import {
  extractionFailure,
  extractionNotice,
  runProgress,
  savedCount,
} from './makeQuiz';
import { type QuizRun, quizRunLinks, useQuizRuns } from './quizRuns';

function QuizRunRow({ run: picked }: { run: QuizRun }) {
  const { data: run } = useExtraction(picked.id, { errorBoundary: false });
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

/** The runs in the upload panel: a heading, then a row each. */
export function QuizRunRows() {
  const runs = useQuizRuns((state) => state.runs);
  const done = useQueries({
    queries: runs.map((run) => extractionQuery(run.id)),
  }).filter(({ data }) => data && data.status !== 'running').length;
  if (runs.length === 0) return null;
  return (
    <>
      <div className="flex h-9 items-center border-divider border-b px-4 py-2">
        <span className="t-label text-fg-muted">
          {m.make_quiz_panel_heading({ count: runs.length, done })}
        </span>
      </div>
      <ul className="max-h-60 overflow-y-auto">
        {runs.map((run) => (
          <QuizRunRow key={run.id} run={run} />
        ))}
      </ul>
    </>
  );
}
