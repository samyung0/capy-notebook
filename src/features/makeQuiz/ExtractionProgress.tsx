import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { qk } from '@/api/client';
import {
  useCancelExtraction,
  useConfirmExtraction,
  useExtraction,
} from '@/api/hooks';
import { EXTRACTION_QUESTION_CREDITS } from '@/api/limits.generated';
import type { Extraction, ExtractionFound } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import {
  affordableQuestions,
  extractionFailure,
  extractionNotice,
  foundPagesLabel,
} from './makeQuiz';
import type { DialogStep } from './PagePicker';

function sourceLine({ answerFiles, paperName, paperPages }: ExtractionFound) {
  return [
    paperName,
    paperPages === 1
      ? m.make_quiz_one_page()
      : paperPages > 1
        ? m.source_pages({ count: paperPages })
        : null,
    answerFiles === 1
      ? m.make_quiz_found_with_answer()
      : answerFiles > 1
        ? m.make_quiz_found_with_answers({ count: answerFiles })
        : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The questions found and their price, or how many the starter can afford. */
function FoundQuestions({
  affordable,
  found,
}: {
  affordable: number;
  found: ExtractionFound;
}) {
  const total = found.questions.length;
  const short = affordable < total;
  return (
    <div className="flex flex-col gap-4 pb-1">
      <p className="t-meta text-fg-muted">{sourceLine(found)}</p>
      {found.unreadAnswers.length > 0 && (
        <p className="text-sm text-tint-error-fg">
          {m.make_quiz_found_unread({
            names: found.unreadAnswers.join(', '),
          })}
        </p>
      )}
      {!short && (
        <ul className="max-h-60 overflow-y-auto border-divider border-y">
          {found.questions.map((question) => (
            <li
              className="grid grid-cols-[48px_minmax(0,1fr)] py-2 text-sm sm:grid-cols-[72px_minmax(0,1fr)]"
              key={`${question.label}:${question.first}`}
            >
              <span className="font-semibold">{question.label}</span>
              <span className="truncate text-fg-muted">
                {foundPagesLabel(question)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between gap-3">
          <span>
            {total === 1
              ? m.make_quiz_price_one({ price: EXTRACTION_QUESTION_CREDITS })
              : m.make_quiz_price_line({
                  count: total,
                  price: EXTRACTION_QUESTION_CREDITS,
                })}
          </span>
          <strong className="shrink-0 font-semibold">
            {m.make_quiz_price_total({
              count: total * EXTRACTION_QUESTION_CREDITS,
            })}
          </strong>
        </div>
        {short ? (
          <div className="flex justify-between gap-3 text-tint-error-fg">
            <span>{m.make_quiz_you_have()}</span>
            <strong className="shrink-0 font-semibold">
              {m.make_quiz_price_total({ count: found.availableCredits })}
            </strong>
          </div>
        ) : (
          <div className="t-meta flex justify-between gap-3 text-fg-muted">
            <span>{m.make_quiz_charged()}</span>
            <span className="shrink-0">
              {m.make_quiz_price_total({ count: found.chargedCredits })}
            </span>
          </div>
        )}
      </div>
      {short && (
        <p className="text-sm">
          {affordable === 0
            ? m.make_quiz_enough_none()
            : affordable === 1
              ? m.make_quiz_enough_one()
              : m.make_quiz_enough({ count: affordable })}
        </p>
      )}
    </div>
  );
}

/**
 * The run, as a step of the Make a quiz dialog: reading until the map ends, then the
 * questions found with their price (Cancel pays only for the map, already charged). A
 * run keeps going if the dialog is closed, and says so when it needs its starter. It
 * follows only what the API says.
 */
export function useRunStep({
  onBack,
  onConfirmed,
  onDone,
  onLeave,
  runId,
}: {
  /** Back to the pages, or out when they aren't known. */
  onBack: () => void;
  onConfirmed: (run: Extraction) => void;
  onDone: (quizId: string) => void;
  onLeave: () => void;
  runId: string | undefined;
}): DialogStep {
  const qc = useQueryClient();
  const id = runId ?? '';
  const { data: run, error } = useExtraction(id, {
    enabled: !!runId,
    errorBoundary: false,
  });
  const {
    mutate: confirm,
    isPending: confirming,
    error: confirmError,
  } = useConfirmExtraction(id);
  const {
    mutate: cancel,
    isPending: cancelling,
    error: cancelError,
  } = useCancelExtraction(id);
  const done = run?.status === 'done' ? run.quizId : undefined;
  const opened = useRef(false);
  const report = run?.report;
  const workspaceId = run?.workspaceId;
  useEffect(() => {
    if (!done || opened.current) return;
    opened.current = true;
    const notice = extractionNotice(report);
    if (notice)
      userToast({
        title: notice,
        variant: report?.stopped === 'credits' ? 'error' : 'warning',
      });
    if (workspaceId)
      void qc.invalidateQueries({ queryKey: qk.materials(workspaceId) });
    onDone(done);
  }, [done, onDone, qc, report, workspaceId]);
  // Cancelled: back to the pages, picks and all.
  const cancelled = run?.status === 'cancelled';
  const leftCancelled = useRef(false);
  useEffect(() => {
    if (!cancelled || leftCancelled.current) return;
    leftCancelled.current = true;
    onBack();
  }, [cancelled, onBack]);

  const found = run?.status === 'confirming' ? run.found : undefined;
  if (run && found) {
    const pending = confirming || cancelling;
    const total = found.questions.length;
    const affordable = affordableQuestions(total, found.availableCredits);
    const short = affordable < total;
    const stepError = confirmError ?? cancelError;
    return {
      action: affordable > 0 && (
        <Button
          disabled={pending}
          onClick={() =>
            confirm(
              { questions: affordable },
              { onSuccess: (next) => onConfirmed(next) }
            )
          }
          type="button"
        >
          {confirming ? (
            <Spinner />
          ) : short ? (
            affordable === 1 ? (
              m.make_quiz_make_one()
            ) : (
              m.make_quiz_make_count({ count: affordable })
            )
          ) : (
            m.make_quiz_make()
          )}
        </Button>
      ),
      body: (
        <>
          <FoundQuestions affordable={affordable} found={found} />
          <FormAlert
            errorId={unexpectedErrorId(stepError)}
            message={
              stepError ? errorCopy(stepError, m.source_try_again()) : null
            }
          />
        </>
      ),
      closable: false,
      footer: (
        <>
          {/* Phones cancel from the header's close. */}
          <span className="contents max-sm:hidden">
            <Button
              disabled={pending}
              onClick={() => cancel()}
              type="button"
              variant="ghost-hover"
            >
              {m.action_cancel()}
            </Button>
          </span>
          {short && (
            // A new tab: this run waits here, and the balance reads again on return.
            <Button asChild variant="outline">
              <Link
                rel="noopener"
                search={{ tab: 'subscription' }}
                target="_blank"
                to="/billing"
              >
                {m.make_quiz_get_credits()}
              </Link>
            </Button>
          )}
        </>
      ),
      // Only Cancel ends the run: a stray click or Escape shouldn't lose the map it paid
      // for, and the dialog closes itself on a route change.
      guarded: true,
      onCloseClick: () => {
        if (!pending) cancel();
      },
      title:
        total === 1
          ? m.make_quiz_found_one()
          : m.make_quiz_found_title({ count: total }),
      width: 600,
    };
  }
  // A failed poll leaves the run on screen: the next one reads it again.
  if (error && !run)
    return {
      body: (
        <ErrorState
          action={
            <Button onClick={onLeave} type="button" variant="outline">
              {m.make_quiz_back_dashboard()}
            </Button>
          }
          errorId={unexpectedErrorId(error)}
          title={m.make_quiz_run_missing()}
          variant="page"
        />
      ),
      title: m.make_quiz_reading_title(),
      width: 600,
    };
  if (run?.status === 'failed')
    return {
      body: (
        <ErrorState
          action={
            <Button onClick={onBack} type="button" variant="outline">
              {m.make_quiz_back_to_pages()}
            </Button>
          }
          description={extractionFailure(run.errorCode)}
          kind={run.errorCode}
          title={m.make_quiz_failed_title()}
          variant="page"
        />
      ),
      title: m.make_quiz_failed_title(),
      width: 600,
    };
  const recorded = run?.recorded ?? 0;
  return {
    body: (
      <div className="flex flex-col items-center gap-4 px-4 py-8 text-center">
        <Spinner />
        <div className="flex flex-col gap-1">
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
      </div>
    ),
    title: m.make_quiz_reading_title(),
    width: 600,
  };
}
