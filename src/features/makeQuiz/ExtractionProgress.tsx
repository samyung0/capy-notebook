import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { qk } from '@/api/client';
import { useExtraction } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { extractionNotice } from './makeQuiz';

/** A link back: to the Dashboard, or to the pages. */
function BackLink({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex cursor-pointer items-center gap-1.5 font-semibold text-fg-secondary underline"
      onClick={onClick}
      type="button"
    >
      <Icon name="navigationBack" size={16} />
      {children}
    </button>
  );
}

/** The run's progress (no board: the closest to X1's page). It follows only
 * what the API says: running with the questions read so far, then the quiz,
 * or the failure. A run keeps going if the page is left. */
export function ExtractionProgress({
  onBackToPages,
  onDone,
  onLeave,
  runId,
}: {
  /** Back to the page picker; undefined when the choice isn't known. */
  onBackToPages?: () => void;
  onDone: (quizId: string) => void;
  onLeave: () => void;
  runId: string;
}) {
  const qc = useQueryClient();
  const { data: run, error } = useExtraction(runId, { errorBoundary: false });
  const done = run?.status === 'done' ? run.quizId : undefined;
  const opened = useRef(false);
  const report = run?.report;
  const workspaceId = run?.workspaceId;
  useEffect(() => {
    if (!done || opened.current) return;
    opened.current = true;
    const notice = extractionNotice(report);
    if (notice) userToast({ title: notice, variant: 'warning' });
    if (workspaceId)
      void qc.invalidateQueries({ queryKey: qk.materials(workspaceId) });
    onDone(done);
  }, [done, onDone, qc, report, workspaceId]);

  if (error)
    return (
      <ErrorState
        action={
          <BackLink onClick={onLeave}>{m.make_quiz_back_dashboard()}</BackLink>
        }
        errorId={unexpectedErrorId(error)}
        title={m.make_quiz_run_missing()}
        variant="page"
      />
    );
  if (run?.status === 'failed')
    return (
      <ErrorState
        action={
          onBackToPages && (
            <BackLink onClick={onBackToPages}>
              {m.make_quiz_back_to_pages()}
            </BackLink>
          )
        }
        description={run.error ?? m.make_quiz_failed_fallback()}
        kind={run.errorCode}
        title={m.make_quiz_failed_title()}
        variant="page"
      />
    );
  const recorded = run?.recorded ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 pb-16 text-center">
      <Spinner />
      <div className="flex flex-col gap-1">
        <h1 className="font-extrabold text-[22px] leading-tight tracking-[-.01rem]">
          {m.make_quiz_reading_title()}
        </h1>
        {run && <p className="font-medium">{run.title}</p>}
        <p aria-live="polite" className="t-meta text-fg-muted" role="status">
          {recorded === 0
            ? m.make_quiz_recorded_none()
            : recorded === 1
              ? m.make_quiz_recorded_one()
              : m.make_quiz_recorded({ count: recorded })}
        </p>
      </div>
      <p className="t-meta max-w-sm text-fg-muted">
        {m.make_quiz_leave_note()}
      </p>
      <BackLink onClick={onLeave}>{m.make_quiz_back_dashboard()}</BackLink>
    </div>
  );
}
