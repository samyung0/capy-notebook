import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isApiError, qk } from '@/api/client';
import {
  onAssignmentClosed,
  saveAssignmentAnswers,
  useSubmitAssignmentAttempt,
} from '@/api/hooks';
import type { AssignmentAttempt } from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import {
  RemovedAssetsContext,
  useRemovedAssets,
} from '@/features/materials/MediaAssetView';
import { answerLabels } from '@/features/questions/editorFields';
import { TextView } from '@/features/questions/QuestionView';
import {
  type LearnerQuestion,
  type QuestionType,
  questionMarks,
} from '@/features/questions/types';
import {
  type Answer,
  type Answers,
  emptyAnswer,
} from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';

/** How long typing rests before answers save. */
const SAVE_AFTER_MS = 2000;

type SaveState = 'saved' | 'saving' | 'failed';

/** What a part's answer must hold to count as answered. */
function answered(value: Answer | undefined) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value))
    return value.some((v) => (typeof v === 'string' ? v.trim() !== '' : true));
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** The board's large line (A2): the question's first text, taken out of what
 * the runner shows, unless it holds a gap's blanks. */
function questionHeading(question?: LearnerQuestion) {
  const [first, ...stem] = question?.stem ?? [];
  if (question && first?.type === 'text')
    return { rest: { ...question, stem }, text: first.text };
  const part = question?.parts.length === 1 ? question.parts[0] : undefined;
  const [line, ...blocks] = part?.blocks ?? [];
  if (question && part && line?.type === 'text' && part.answer.type !== 'gaps')
    return {
      rest: { ...question, parts: [{ ...part, blocks }] },
      text: line.text,
    };
  return { rest: question as LearnerQuestion, text: '' };
}

/** Bookmarks stay in this browser: they are only for the member to come back
 * to, and recorded nowhere else (§7). */
function useBookmarks(attemptId: string) {
  const key = `capy.assignment.bookmarks.${attemptId}`;
  const [marks, setMarks] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const toggle = (id: string) =>
    setMarks((list) => {
      const next = list.includes(id)
        ? list.filter((m) => m !== id)
        : [...list, id];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Browsers can disable local storage; the marks last the page.
      }
      return next;
    });
  return { marks, toggle };
}

/** The clock left, counted from the server's time at the read. */
function useTimeLeft(deadlineAt: string | undefined, serverNow: string) {
  const offset = useRef(Date.parse(serverNow) - Date.now());
  const left = useCallback(
    () =>
      deadlineAt
        ? Date.parse(deadlineAt) - (Date.now() + offset.current)
        : null,
    [deadlineAt]
  );
  const [ms, setMs] = useState(left);
  useEffect(() => {
    if (!deadlineAt) return;
    const tick = setInterval(() => setMs(left()), 1000);
    return () => clearInterval(tick);
  }, [deadlineAt, left]);
  return ms;
}

function clockText(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Answering an assignment (A2): one question at a time beside a grid of
 * numbers, ruled lines for written answers, answers saving as they change, and
 * the server's clock. At zero, or when staff close the assignment (Epo
 * 2026-11-05), it submits what is on the page; if the tab is closed the server
 * submits what was saved. */
export function AssignmentTake({
  attempt,
  workspaceId,
}: {
  attempt: AssignmentAttempt;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const questions = attempt.questions as LearnerQuestion[];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>(attempt.answers);
  const [save, setSave] = useState<SaveState>('saved');
  const [confirming, setConfirming] = useState(false);
  const { marks: bookmarks, toggle: toggleBookmark } = useBookmarks(attempt.id);
  const removed = useRemovedAssets(attempt.removedAssetIds);
  const { mutate: submitAttempt, isPending: submitting } =
    useSubmitAssignmentAttempt(workspaceId);
  const left = useTimeLeft(attempt.deadlineAt, attempt.now);
  const latest = useRef(answers);
  latest.current = answers;
  const dirty = useRef(false);
  const saving = useRef(false);

  // The server submitted it already: its page shows what it holds.
  const finished = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.assignmentAttempt(attempt.id) });
  }, [attempt.id, qc]);

  const flush = useCallback(async () => {
    if (!dirty.current || saving.current) return;
    dirty.current = false;
    saving.current = true;
    setSave('saving');
    let failed = false;
    try {
      await saveAssignmentAnswers(attempt.id, latest.current);
      setSave(dirty.current ? 'saving' : 'saved');
    } catch (error) {
      failed = true;
      if (isApiError(error) && error.status === 409) return finished();
      // Sent again with the next change and with Submit, which sends them all.
      dirty.current = true;
      setSave('failed');
    } finally {
      saving.current = false;
      // A change made during this save: its wait may have ended meanwhile.
      if (dirty.current && !failed) void flush();
    }
  }, [attempt.id, finished]);

  const change = (partId: string, value: Answer) => {
    setAnswers((current) => ({ ...current, [partId]: value }));
    dirty.current = true;
    setSave('saving');
  };
  useEffect(() => {
    if (!dirty.current) return;
    const wait = setTimeout(() => void flush(), SAVE_AFTER_MS);
    return () => clearTimeout(wait);
  }, [answers, flush]);
  // Leaving the page or hiding the tab saves what the wait above still holds.
  useEffect(() => {
    const leaving = () => void flush();
    document.addEventListener('visibilitychange', leaving);
    return () => {
      document.removeEventListener('visibilitychange', leaving);
      leaving();
    };
  }, [flush]);
  // An ordering part always shows an order, so showing it is answering it.
  const question = questions[index];
  useEffect(() => {
    if (!question) return;
    for (const part of question.parts)
      if (part.answer.type === 'ordering' && !latest.current[part.id]) {
        setAnswers((current) => ({
          ...current,
          [part.id]: emptyAnswer(part),
        }));
        dirty.current = true;
      }
  }, [question]);

  const submit = useCallback(() => {
    setConfirming(false);
    dirty.current = false;
    submitAttempt(
      { answers: latest.current, id: attempt.id },
      {
        onError: (error) => {
          if (isApiError(error) && error.status === 409) return finished();
          dirty.current = true;
          userToast({
            description: errorCopy(error, m.assignment_submit_failed_body()),
            title: m.assignment_submit_failed(),
            variant: 'error',
          });
        },
      }
    );
  }, [attempt.id, finished, submitAttempt]);
  const timedOut = left !== null && left <= 0;
  const once = useRef(false);
  const end = useCallback(() => {
    if (once.current) return;
    once.current = true;
    submit();
  }, [submit]);
  useEffect(() => {
    if (timedOut) end();
  }, [end, timedOut]);
  useEffect(
    () =>
      onAssignmentClosed((id) => {
        if (id === attempt.assignmentId) end();
      }),
    [attempt.assignmentId, end]
  );

  const isAnswered = (q: (typeof questions)[number]) =>
    q.parts.some((part) => answered(answers[part.id]));
  const answeredCount = questions.filter(isAnswered).length;
  const unanswered = questions.length - answeredCount;
  const go = (next: number) => {
    void flush();
    setIndex(next);
  };
  const type = question?.parts[0]?.answer.type as QuestionType | undefined;
  const heading = useMemo(() => questionHeading(question), [question]);

  return (
    <RemovedAssetsContext.Provider value={removed}>
      <div className="flex min-h-0 flex-1 flex-col" data-assignment-take>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-divider border-b px-4 py-2.5 sm:px-5 lg:min-h-15">
          <div className="flex min-w-0 flex-1 items-center gap-2 max-lg:basis-full lg:flex-[1_1_0]">
            <span className="truncate font-bold">{attempt.title}</span>
            <span className="inline-flex h-5.5 shrink-0 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs">
              {m.assignment_chip()}
            </span>
          </div>
          {left !== null && (
            <span
              aria-live="off"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-page-hover px-3.5 font-bold"
              role="timer"
            >
              <Icon name="clock" size={16} />
              {m.assignment_time_left({ time: clockText(left) })}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center justify-end gap-3.5 lg:flex-[1_1_0]">
            <span
              aria-live="polite"
              className={cn(
                't-meta',
                save === 'failed' ? 'text-tint-error-fg' : 'text-fg-secondary'
              )}
            >
              {save === 'saved'
                ? m.assignment_saved()
                : save === 'saving'
                  ? m.assignment_saving()
                  : m.assignment_not_saved()}
            </span>
            <Button disabled={submitting} onClick={() => setConfirming(true)}>
              {submitting ? m.assignment_submitting() : m.assignment_submit()}
            </Button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label={m.assignment_questions_nav()}
            className="shrink-0 border-divider max-md:border-b md:w-50 md:overflow-auto md:border-r md:px-4 md:py-5"
          >
            <div className="max-md:hidden">
              <p className="t-label text-fg-muted uppercase">
                {m.practice_col_questions()}
              </p>
              <p className="t-meta mt-1.5 text-fg-secondary">
                {m.assignment_answered_of({
                  answered: answeredCount,
                  total: questions.length,
                })}
              </p>
            </div>
            <ol className="flex gap-2 overflow-x-auto px-4 py-2.5 [scrollbar-width:none] md:mt-3 md:grid md:grid-cols-4 md:overflow-visible md:p-0">
              {questions.map((q, i) => {
                const current = i === index;
                const done = isAnswered(q);
                const marked = bookmarks.includes(q.id);
                return (
                  <li className="shrink-0" key={q.id}>
                    <button
                      aria-current={current ? 'step' : undefined}
                      aria-label={m.assignment_question_n({ number: i + 1 })}
                      className={cn(
                        'relative grid size-9 place-items-center rounded-[10px] border font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action',
                        done
                          ? 'border-transparent bg-tint-accent-1 text-tint-accent-1-fg'
                          : 'border-line text-fg',
                        current && 'border-2 border-solid-accent-1'
                      )}
                      onClick={() => go(i)}
                      type="button"
                    >
                      {i + 1}
                      {marked && (
                        <Icon
                          className="absolute top-0 right-0.5 text-solid-accent-1"
                          name="bookmark"
                          size={11}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
            <ul className="t-meta mt-3.5 flex flex-col gap-2 text-fg-secondary max-md:hidden">
              <Legend className="bg-tint-accent-1">
                {m.assignment_legend_answered()}
              </Legend>
              <Legend className="border-2 border-solid-accent-1">
                {m.assignment_legend_current()}
              </Legend>
              <li className="flex items-center gap-2">
                <Icon
                  className="text-solid-accent-1"
                  name="bookmark"
                  size={14}
                />
                {m.assignment_legend_bookmarked()}
              </li>
              <Legend className="border border-line">
                {m.assignment_legend_not_answered()}
              </Legend>
            </ul>
          </nav>
          <div className="min-h-0 flex-1 overflow-auto px-4 pt-6 pb-24 sm:px-6 lg:px-21.5 lg:pt-12 lg:pb-10">
            {question && (
              <div
                className="motion-safe:motion-text-in mx-auto flex w-full max-w-180 flex-col gap-3"
                key={question.id}
              >
                <p className="t-meta text-fg-secondary">
                  {m.assignment_question_meta({
                    marks: questionMarks(question),
                    number: index + 1,
                    type: type ? answerLabels[type]() : '',
                  })}
                </p>
                {heading.text && (
                  <h2 className="font-extrabold text-[1.25rem] leading-snug tracking-[-0.01rem] lg:text-[1.375rem]">
                    <TextView text={heading.text} />
                  </h2>
                )}
                {/* Written answers get the paper's room on this page. */}
                <div className="[&_textarea]:max-h-none [&_textarea]:min-h-[calc(var(--ruled-line)*10)]">
                  <QuestionRunner
                    answers={answers}
                    headerMarks={false}
                    onChange={change}
                    question={heading.rest}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <Button
                    iconLeft="bookmark"
                    onClick={() => toggleBookmark(question.id)}
                    size="sm"
                    variant={
                      bookmarks.includes(question.id) ? 'gray' : 'outline'
                    }
                  >
                    {m.assignment_bookmark()}
                  </Button>
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      disabled={index === 0}
                      iconLeft="arrowLeft"
                      onClick={() => go(index - 1)}
                      variant="outline"
                    >
                      {m.action_previous()}
                    </Button>
                    <Button
                      disabled={index === questions.length - 1}
                      iconRight="arrowRight"
                      onClick={() => go(index + 1)}
                    >
                      {m.action_next()}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {confirming && (
        <Dialog onOpenChange={(open) => !open && setConfirming(false)} open>
          <DialogContent
            aria-describedby={undefined}
            className="sm:max-w-115"
            compact
            showCloseButton={false}
          >
            <DialogTitle closable={false}>
              {m.assignment_submit_confirm()}
            </DialogTitle>
            <p className="mt-1 text-fg-secondary">
              {unanswered === 0
                ? m.assignment_submit_all_answered()
                : unanswered === 1
                  ? m.assignment_submit_unanswered_one()
                  : m.assignment_submit_unanswered({ count: unanswered })}
            </p>
            <DialogFooter>
              <Button onClick={() => setConfirming(false)} variant="ghost">
                {m.action_cancel()}
              </Button>
              <Button disabled={submitting} onClick={submit}>
                {m.assignment_submit()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </RemovedAssetsContext.Provider>
  );
}

function Legend({
  children,
  className,
}: {
  children: string;
  className: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden className={cn('size-3.5 rounded-xs', className)} />
      {children}
    </li>
  );
}
