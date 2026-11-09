import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isApiError, qk } from '@/api/client';
import {
  deleteAssignmentDrawing,
  onAssignmentEvent,
  saveAssignmentAnswers,
  saveAssignmentDrawing,
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
import { FormAlert } from '@/components/ui/FormAlert';
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
  DrawingDraftScope,
  DrawingUploader,
  type DrawingValue,
  finishOpenDrawing,
} from '@/features/quizzes/drawing/drawingValue';
import {
  type Answer,
  type Answers,
  emptyAnswer,
} from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { QuizSplit, RowMark } from '@/features/quizzes/QuizSplit';
import { keptAnswers, partsById } from '@/features/quizzes/stillAnswers';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { PaperPane } from './LazyPaper';
import { useAddSubmissionFiles } from './useAddSubmissionFiles';

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

/** The clock left, counted from the server's time at the read. With `within`,
 * it ticks each second only from that long before the end: until then it
 * rechecks once a minute, which also survives a sleeping laptop. */
function useTimeLeft(
  deadlineAt: string | undefined,
  serverNow: string,
  within?: number
) {
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
    // An end taken away (No late turned off) leaves no clock.
    setMs(left());
    if (!deadlineAt) return;
    let tick: ReturnType<typeof setInterval> | undefined;
    let later: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const wait = within === undefined ? 0 : (left() ?? 0) - within;
      if (wait > 0) {
        later = setTimeout(arm, Math.min(wait, 60_000));
        return;
      }
      setMs(left());
      tick = setInterval(() => setMs(left()), 1000);
    };
    arm();
    return () => {
      clearTimeout(later);
      clearInterval(tick);
    };
  }, [deadlineAt, left, within]);
  return ms;
}

const HOUR = 60 * 60 * 1000;

/** The earliest of the times given, if any. */
const earliest = (...times: (string | undefined)[]) =>
  times
    .filter((t): t is string => !!t)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

function clockText(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Answering an assignment: one question at a time beside the quiz's list, on a
 * phone under a strip of numbers (Epo Q679 B) with the clock and Submit along the
 * bottom and no header, ruled lines for written answers, answers saving as they
 * change, and the server's clock. At zero, or when staff close the assignment (Epo
 * 2026-11-05), it submits what is on the page; if the tab is closed the server
 * submits what was saved. */
export function AssignmentTake({
  attempt,
  leave,
  onClosed,
  workspaceId,
}: {
  attempt: AssignmentAttempt;
  /** The way out on a phone, which has no header here (answers stay saved). */
  leave?: ReactNode;
  /** Staff closed it while it was open here: its results come next. */
  onClosed: () => void;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const questions = attempt.questions as LearnerQuestion[];
  // Answered on paper (S5): the questions read only, then Your paper.
  const paper = attempt.paper === 'upload';
  const files = attempt.paperFiles;
  const [paperOpen, setPaperOpen] = useState(paper);
  const [wantedIndex, setIndex] = useState(0);
  // New questions can be fewer: the last one stands in.
  const index = Math.min(wantedIndex, Math.max(questions.length - 1, 0));
  const [answers, setAnswers] = useState<Answers>(attempt.answers);
  const [save, setSave] = useState<SaveState>('saved');
  const [confirming, setConfirming] = useState(false);
  const [submitError, setSubmitError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const { marks: bookmarks, toggle: toggleBookmark } = useBookmarks(attempt.id);
  const removed = useRemovedAssets(attempt.removedAssetIds);
  const { mutate: submitAttempt, isPending: submitting } =
    useSubmitAssignmentAttempt(workspaceId);
  // Your paper's uploads, held here: Submit waits for them, while the clock's
  // own submit does not (finding 6).
  const uploads = useAddSubmissionFiles({ attemptId: attempt.id });
  const uploading = uploads.uploading.length > 0;
  // It ends at the earlier of its time running out and a No late due date.
  const left = useTimeLeft(
    earliest(attempt.deadlineAt, attempt.closesAt),
    attempt.now,
    attempt.deadlineAt ? undefined : HOUR
  );
  const latest = useRef(answers);
  latest.current = answers;
  const dirty = useRef(false);
  const saving = useRef(false);

  // The server submitted it already, or republished it: read what it holds.
  const reread = useCallback(() => {
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
      if (isApiError(error) && error.status === 409) return reread();
      // Sent again with the next change and with Submit, which sends them all.
      dirty.current = true;
      setSave('failed');
    } finally {
      saving.current = false;
      // A change made during this save: its wait may have ended meanwhile.
      if (dirty.current && !failed) void flush();
    }
  }, [attempt.id, reread]);

  // Done stores a drawing part's board at once (Epo 2026-11-06); saves name it.
  // Marked by hand, it makes no marking image (Q693).
  const storeDrawing = useMemo(
    () => ({
      store: (partId: string, value: DrawingValue | null) =>
        value
          ? saveAssignmentDrawing(attempt.id, partId, value)
          : deleteAssignmentDrawing(attempt.id, partId).then(() => null),
      withImage: attempt.drawingImages,
    }),
    [attempt.id, attempt.drawingImages]
  );
  const change = (partId: string, value: Answer) => {
    // Read at once by a submit that follows (a board finished at zero).
    latest.current = { ...latest.current, [partId]: value };
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
  // Republished under the page: answers that no longer fit go, as on its next
  // load (`dropStaleAnswersTx`).
  const parts = useMemo(() => partsById(questions), [questions]);
  const previousParts = useRef(parts);
  useEffect(() => {
    const before = previousParts.current;
    previousParts.current = parts;
    if (before === parts) return;
    const kept = keptAnswers(before, parts, latest.current);
    if (kept === latest.current) return;
    setAnswers(kept);
    dirty.current = true;
  }, [parts]);
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

  // Asked from the confirm dialog, a refusal stays in it; at zero or on closing
  // there is no dialog to hold it, so it toasts.
  const submit = useCallback(
    (fromDialog = false) => {
      setSubmitError(null);
      dirty.current = false;
      submitAttempt(
        { answers: latest.current, id: attempt.id },
        {
          onError: (error) => {
            if (isApiError(error) && error.status === 409) {
              setConfirming(false);
              return reread();
            }
            dirty.current = true;
            if (fromDialog) {
              setSubmitError({
                errorId: unexpectedErrorId(error),
                message: errorCopy(error, m.assignment_submit_failed_body()),
              });
              return;
            }
            userToast({
              description: errorCopy(error, m.assignment_submit_failed_body()),
              title: m.assignment_submit_failed(),
              variant: 'error',
            });
          },
          onSuccess: () => setConfirming(false),
        }
      );
    },
    [attempt.id, reread, submitAttempt]
  );
  const timedOut = left !== null && left <= 0;
  const once = useRef(false);
  // A drawing board open when the time runs out is submitted as it stands; one
  // open when the assignment closes is not, as nothing is taken at a close
  // (Epo 2026-11-06).
  const end = useCallback(
    async (board: 'finish' | 'drop') => {
      if (once.current) return;
      once.current = true;
      if (board === 'finish') await finishOpenDrawing().catch(() => undefined);
      submit();
    },
    [submit]
  );
  useEffect(() => {
    if (timedOut) void end('finish');
  }, [end, timedOut]);
  useEffect(
    () =>
      onAssignmentEvent((event) => {
        if (event.assignmentId !== attempt.assignmentId) return;
        if (event.type === 'assignment_republished') {
          reread();
          userToast({ title: m.assignment_questions_updated() });
          return;
        }
        // Its settings changed: a moved due date moves the clock.
        if (event.type === 'assignment_updated') {
          reread();
          return;
        }
        onClosed();
        void end('drop');
      }),
    [attempt.assignmentId, end, onClosed, reread]
  );

  const isAnswered = (q: (typeof questions)[number]) =>
    q.parts.some((part) => answered(answers[part.id]));
  // A multi-part question with some of its parts left isn't done.
  const isComplete = (q: (typeof questions)[number]) =>
    q.parts.every((part) => answered(answers[part.id]));
  const stateLabel = (q: (typeof questions)[number]) =>
    isComplete(q)
      ? m.assignment_legend_answered()
      : isAnswered(q)
        ? m.assignment_legend_part_answered()
        : m.assignment_legend_not_answered();
  const answeredCount = questions.filter(isAnswered).length;
  const unanswered = questions.length - answeredCount;
  const go = (next: number) => {
    void flush();
    setPaperOpen(false);
    setIndex(next);
  };
  const paperLabel =
    files.length === 1
      ? m.assignment_paper_one_file()
      : m.assignment_paper_files({ count: files.length });
  const type = question?.parts[0]?.answer.type as QuestionType | undefined;
  const heading = useMemo(() => questionHeading(question), [question]);

  // A timed attempt always shows its clock; one only a due date ends shows it
  // in the last hour (Epo 2026-11-08).
  const clock = left !== null && (!!attempt.deadlineAt || left <= HOUR) && (
    <span
      aria-live="off"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-page-hover px-3.5 font-bold"
      role="timer"
    >
      <Icon name="clock" size={16} />
      {m.assignment_time_left({ time: clockText(left) })}
    </span>
  );
  const savedState = (
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
  );
  const confirmText = paper
    ? files.length === 0
      ? m.assignment_submit_paper_empty()
      : files.length === 1
        ? m.assignment_submit_paper_one()
        : m.assignment_submit_paper({ count: files.length })
    : unanswered === 0
      ? m.assignment_submit_all_answered()
      : unanswered === 1
        ? m.assignment_submit_unanswered_one()
        : m.assignment_submit_unanswered({ count: unanswered });
  const submitButton = (
    <span title={uploading ? m.assignment_submit_wait_upload() : undefined}>
      <Button
        disabled={submitting || uploading}
        onClick={() => setConfirming(true)}
      >
        {submitting ? m.assignment_submitting() : m.assignment_submit()}
      </Button>
    </span>
  );

  return (
    <RemovedAssetsContext.Provider value={removed}>
      <DrawingDraftScope.Provider value={`assignment:${attempt.id}`}>
        <DrawingUploader.Provider value={storeDrawing}>
          <div className="flex min-h-0 flex-1 flex-col" data-assignment-take>
            <header className="hidden flex-wrap items-center gap-x-3 gap-y-2 border-divider border-b px-4 py-2.5 sm:px-5 md:flex lg:min-h-15">
              <div className="flex min-w-0 flex-1 items-center gap-2 max-lg:basis-full lg:flex-[1_1_0]">
                <span className="truncate font-bold">{attempt.title}</span>
                <span className="inline-flex h-5.5 shrink-0 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs">
                  {m.assignment_chip()}
                </span>
              </div>
              {clock}
              <div className="ml-auto flex shrink-0 items-center justify-end gap-3.5 lg:flex-[1_1_0]">
                {!paper && savedState}
                {submitButton}
              </div>
            </header>
            <QuizSplit
              above={
                !paper && (
                  <p className="t-meta px-1.5 pb-1.5 text-fg-secondary">
                    {m.assignment_answered_of({
                      answered: answeredCount,
                      total: questions.length,
                    })}
                  </p>
                )
              }
              below={
                paper && (
                  <>
                    <div className="mx-2 my-2 h-px bg-divider" />
                    <button
                      aria-current={paperOpen || undefined}
                      className={cn(
                        'grid min-h-9 w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1 text-left text-[13.5px] outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
                        paperOpen && 'bg-page-hover hover:bg-page-hover'
                      )}
                      data-paper-row
                      onClick={() => setPaperOpen(true)}
                      type="button"
                    >
                      <Icon
                        className="text-fg-secondary"
                        name="fileText"
                        size={18}
                      />
                      <span className="truncate font-semibold">
                        {m.assignment_paper_title()}
                      </span>
                      <span className="text-fg-muted text-xs">
                        {paperLabel}
                      </span>
                    </button>
                  </>
                )
              }
              current={paperOpen ? undefined : question?.id}
              onBack={() => undefined}
              onOpen={(id) => go(questions.findIndex((q) => q.id === id))}
              onQuestion
              phoneStrip={
                <div className="flex shrink-0 items-center border-divider border-b md:hidden">
                  <span className="shrink-0 pl-2">{leave}</span>
                  <nav
                    aria-label={m.assignment_questions_nav()}
                    className="min-w-0 flex-1"
                  >
                    <ol className="flex gap-2 overflow-x-auto px-2.5 py-2.5 [scrollbar-width:none]">
                      {questions.map((q, i) => {
                        const marked = bookmarks.includes(q.id);
                        const name = [
                          m.assignment_question_n({ number: i + 1 }),
                          stateLabel(q),
                          ...(marked ? [m.assignment_legend_bookmarked()] : []),
                        ].join(', ');
                        return (
                          <li className="shrink-0" key={q.id}>
                            <button
                              aria-current={
                                i === index && !paperOpen ? 'step' : undefined
                              }
                              aria-label={name}
                              className={cn(
                                'relative grid size-9 place-items-center rounded-[10px] border font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action',
                                isComplete(q)
                                  ? 'border-transparent bg-tint-accent-1 text-tint-accent-1-fg'
                                  : isAnswered(q)
                                    ? 'border-solid-accent-1 border-dashed text-fg'
                                    : 'border-line text-fg',
                                i === index &&
                                  !paperOpen &&
                                  'border-2 border-solid-accent-1 border-solid'
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
                      {paper && (
                        <li className="shrink-0">
                          <button
                            aria-current={paperOpen ? 'step' : undefined}
                            className={cn(
                              'inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line px-2.5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action',
                              paperOpen &&
                                'border-2 border-solid-accent-1 border-solid'
                            )}
                            onClick={() => setPaperOpen(true)}
                            type="button"
                          >
                            <Icon name="fileText" size={16} />
                            {m.assignment_paper_chip()}
                          </button>
                        </li>
                      )}
                    </ol>
                  </nav>
                </div>
              }
              questions={questions}
              rowEnd={(q) => (
                <>
                  {bookmarks.includes(q.id) && (
                    <RowMark label={m.assignment_legend_bookmarked()}>
                      <Icon
                        className="text-solid-accent-1"
                        name="bookmark"
                        size={18}
                      />
                    </RowMark>
                  )}
                  {!paper && isAnswered(q) ? (
                    <RowMark label={stateLabel(q)}>
                      <span
                        className={cn(
                          'size-2.5 rounded-full border-2 border-solid-accent-1',
                          isComplete(q) && 'bg-solid-accent-1'
                        )}
                      />
                    </RowMark>
                  ) : (
                    questionMarks(q)
                  )}
                </>
              )}
            >
              <div className="px-4 pt-6 pb-6 sm:px-6 md:pb-24 lg:px-21.5 lg:pt-12 lg:pb-10">
                {paperOpen && (
                  <PaperPane
                    attemptId={attempt.id}
                    files={files}
                    uploads={uploads}
                  />
                )}
                {!paperOpen && question && (
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
                        disabled={paper}
                        // On paper, the question alone: no field to answer in.
                        frameAnswer={paper ? () => null : undefined}
                        headerMarks={false}
                        onChange={change}
                        question={heading.rest}
                      />
                    </div>
                    {paper && (
                      <p className="t-meta rounded-lg bg-page-hover px-3 py-2.5 text-fg-secondary">
                        {m.assignment_paper_on_paper()}
                      </p>
                    )}
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
                          disabled={!paper && index === questions.length - 1}
                          iconRight="arrowRight"
                          onClick={() =>
                            index === questions.length - 1
                              ? setPaperOpen(true)
                              : go(index + 1)
                          }
                        >
                          {m.action_next()}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </QuizSplit>
            <div className="flex shrink-0 items-center gap-3 border-divider border-t px-4 py-2.5 md:hidden">
              {clock}
              <span className="ml-auto flex items-center gap-3">
                {!paper && savedState}
                {submitButton}
              </span>
            </div>
          </div>
          {confirming && (
            <Dialog
              onOpenChange={(open) => {
                if (open || submitting) return;
                setConfirming(false);
                setSubmitError(null);
              }}
              open
            >
              <DialogContent
                aria-describedby={undefined}
                className="sm:max-w-115"
                compact
                showCloseButton={false}
              >
                <DialogTitle closable={false}>
                  {m.assignment_submit_confirm()}
                </DialogTitle>
                <p className="mt-1 text-fg-secondary">{confirmText}</p>
                <FormAlert
                  errorId={submitError?.errorId}
                  message={submitError?.message ?? null}
                />
                <DialogFooter>
                  <Button
                    disabled={submitting}
                    onClick={() => {
                      setConfirming(false);
                      setSubmitError(null);
                    }}
                    variant="ghost"
                  >
                    {m.action_cancel()}
                  </Button>
                  <Button
                    disabled={submitting || uploading}
                    onClick={() => submit(true)}
                  >
                    {submitting
                      ? m.assignment_submitting()
                      : m.assignment_submit()}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </DrawingUploader.Provider>
      </DrawingDraftScope.Provider>
    </RemovedAssetsContext.Provider>
  );
}
