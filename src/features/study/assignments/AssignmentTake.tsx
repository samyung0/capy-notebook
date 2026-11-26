import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import type { AssignmentAttempt, AssignmentFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { userToast } from '@/components/ui/userToast';
import {
  RemovedAssetsContext,
  useRemovedAssets,
} from '@/features/materials/MediaAssetView';
import { answerLabels } from '@/features/questions/editorFields';
import { TextView } from '@/features/questions/QuestionView';
import {
  type LearnerQuestion,
  type Question,
  type QuestionType,
  questionMarks,
} from '@/features/questions/types';
import { partAnswer } from '@/features/quizzes/drawing/canvasParts';
import {
  copyDrawingDrafts,
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
import { QuizSplit } from '@/features/quizzes/QuizSplit';
import { keptAnswers, renamedDrafts } from '@/features/quizzes/stillAnswers';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { earliest, HOUR, TimeLeft, useTimeLeft } from './assignmentClock';
import { PaperPane, QuestionPaperCard, QuestionPaperView } from './LazyPaper';
import { PaperSheet } from './PaperSheet';
import { NumberStrip, QuestionNumbers } from './QuestionNumbers';
import { SplitColumns } from './SplitColumns';
import { useAddSubmissionFiles } from './useAddSubmissionFiles';

/** How long typing rests before answers save. */
const SAVE_AFTER_MS = 2000;

type SaveState = 'saved' | 'saving' | 'failed';

/** What a part's answer must hold to count as answered. */
export function answered(value: Answer | undefined) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value))
    return value.some((v) => (typeof v === 'string' ? v.trim() !== '' : true));
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** The board's large line (A2): the question's first text, taken out of what
 * the runner shows, unless it holds a gap's blanks. */
function questionHeading(question: LearnerQuestion | Question): {
  rest: LearnerQuestion | Question;
  text: string;
} {
  const [first, ...stem] = question.stem;
  if (first?.type === 'text')
    return { rest: { ...question, stem }, text: first.text };
  const part = question.parts.length === 1 ? question.parts[0] : undefined;
  const [line, ...blocks] = part?.blocks ?? [];
  if (part && line?.type === 'text' && part.answer.type !== 'gaps')
    return {
      rest: { ...question, parts: [{ ...part, blocks }] } as
        | LearnerQuestion
        | Question,
      text: line.text,
    };
  return { rest: question, text: '' };
}

/** The answering pane's room around its question. */
export const TAKE_PANE =
  'px-4 pt-6 pb-6 sm:px-6 md:pb-24 lg:px-21.5 lg:pt-12 lg:pb-10';

/** One question as a member answers it (A2): its number, type and marks, its
 * first text as the large line, then its answers; `children` closes it (the
 * row of Bookmark, Previous and Next). Staff's Preview shows the same. */
export function TakeQuestion({
  answers,
  children,
  number,
  onChange,
  question,
}: {
  answers: Answers;
  children?: ReactNode;
  number: number;
  onChange: (partId: string, value: Answer) => void;
  question: LearnerQuestion | Question;
}) {
  const type = question.parts[0]?.answer.type as QuestionType | undefined;
  const heading = useMemo(() => questionHeading(question), [question]);
  return (
    <div className="motion-safe:motion-text-in mx-auto flex w-full max-w-180 flex-col gap-3">
      <p className="t-meta text-fg-secondary">
        {m.assignment_question_meta({
          marks: questionMarks(question),
          number,
          type: type ? answerLabels[type]() : '',
        })}
      </p>
      {heading.text && (
        <h2 className="font-extrabold text-[1.25rem] leading-snug tracking-[-0.01rem] lg:text-[1.375rem]">
          <TextView marks text={heading.text} />
        </h2>
      )}
      {/* Written answers get the room of a page. */}
      <div className="[&_textarea]:max-h-none [&_textarea]:min-h-[calc(var(--ruled-line)*10)]">
        <QuestionRunner
          answers={answers}
          headerMarks={false}
          onChange={onChange}
          pinFrom={{ number, question }}
          question={heading.rest}
        />
      </div>
      {children}
    </div>
  );
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
  questionPaper,
  workspaceId,
}: {
  attempt: AssignmentAttempt;
  /** A file's graded quiz (Epo 2026-11-20): its question paper, read in the
   * file viewer in place of the questions; null when it can't be opened. */
  questionPaper?: AssignmentFile | null;
  /** The way out on a phone, which has no header here (answers stay saved). */
  leave?: ReactNode;
  /** Staff closed it while it was open here: its results come next. */
  onClosed: () => void;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const questions = attempt.questions as LearnerQuestion[];
  // Answered by upload (S5): the questions read only beside Your answers.
  const paper = attempt.paper === 'upload';
  const files = attempt.paperFiles;
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
  // Republished under the page: answers that no longer fit go, and a
  // drawing follows its canvas, as the server moved it (`dropStaleAnswersTx`,
  // Epo 2026-11-24). A device draft is kept by canvas: only a canvas the
  // republish renamed (an Ungroup's) copies it, before the boards read it.
  const previousQuestions = useRef(questions);
  useLayoutEffect(() => {
    const before = previousQuestions.current;
    previousQuestions.current = questions;
    if (before === questions) return;
    copyDrawingDrafts(
      `assignment:${attempt.id}`,
      renamedDrafts(before, questions)
    );
    const kept = keptAnswers(before, questions, latest.current);
    if (kept === latest.current) return;
    latest.current = kept;
    setAnswers(kept);
    dirty.current = true;
  }, [attempt.id, questions]);
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

  // A part answered in the canvas above is answered by its drawing.
  const isAnswered = (q: (typeof questions)[number]) =>
    q.parts.some((part) => answered(partAnswer(q, answers, part)));
  // A multi-part question with some of its parts left isn't done.
  const isComplete = (q: (typeof questions)[number]) =>
    q.parts.every((part) => answered(partAnswer(q, answers, part)));
  const answeredCount = questions.filter(isAnswered).length;
  const unanswered = questions.length - answeredCount;
  const go = (next: number) => {
    void flush();
    setIndex(next);
  };
  const open = (id: string) => go(questions.findIndex((q) => q.id === id));
  const items = questions.map((q) => ({
    id: q.id,
    marked: bookmarks.includes(q.id),
    state: isComplete(q)
      ? ('complete' as const)
      : isAnswered(q)
        ? ('answered' as const)
        : ('empty' as const),
  }));

  // A timed attempt always shows its clock; one only a due date ends shows it
  // in the last hour (Epo 2026-11-08).
  const clock = left !== null && (!!attempt.deadlineAt || left <= HOUR) && (
    <TimeLeft ms={left} />
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
  // Final either way; a paper with files says how many, and what is missing
  // follows it in the error colour (Epo 2026-11-25).
  const confirmText =
    paper && files.length
      ? files.length === 1
        ? m.assignment_submit_paper_one()
        : m.assignment_submit_paper({ count: files.length })
      : m.assignment_submit_all_answered();
  const confirmMissing = paper
    ? files.length === 0 && m.assignment_submit_paper_empty()
    : unanswered > 0 && m.assignment_submit_unanswered();
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
            {paper && questionPaper !== undefined ? (
              // A file's graded quiz (mock Attempt): the question paper's
              // card above Your answers at the side, the file in the
              // workspace's viewer beside them; a phone reads the file
              // first, its name and Download over it, Your answers under it.
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center gap-1 border-divider border-b py-1.5 pr-4 pl-2 md:hidden">
                  {leave}
                  <span className="truncate font-bold">{attempt.title}</span>
                </div>
                <SplitColumns
                  className="min-h-0 flex-1"
                  mainClassName="min-h-0 flex-1"
                  side={
                    <>
                      <QuestionPaperCard
                        className="border-divider border-b pb-4 max-md:hidden"
                        file={questionPaper}
                      />
                      <PaperPane
                        attemptId={attempt.id}
                        files={files}
                        uploads={uploads}
                      />
                    </>
                  }
                  sideClassName="flex flex-col gap-4 border-divider border-t px-4 py-3 max-md:order-last max-md:max-h-[40dvh] max-md:overflow-y-auto md:border-t-0"
                >
                  <QuestionPaperView file={questionPaper} />
                </SplitColumns>
              </div>
            ) : paper ? (
              // Answered by upload (S5, Epo 2026-11-19): Your answers beside
              // the questions as a printed paper, in Grading's two columns
              // (Epo 2026-11-25, mock A). Phones scroll Your answers above
              // the questions.
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
                <div className="flex items-center gap-1 border-divider border-b py-1.5 pr-4 pl-2 md:hidden">
                  {leave}
                  <span className="truncate font-bold">{attempt.title}</span>
                </div>
                <SplitColumns
                  className="md:flex-1"
                  mainClassName="md:overflow-y-auto"
                  side={
                    <PaperPane
                      attemptId={attempt.id}
                      files={files}
                      uploads={uploads}
                    />
                  }
                  sideClassName="border-divider border-b px-4 py-3 md:border-b-0"
                >
                  <div className="mx-auto max-w-205 px-4 pt-4 pb-6 sm:px-6 md:pb-24 lg:pt-6">
                    <PaperSheet questions={questions} />
                  </div>
                </SplitColumns>
              </div>
            ) : (
              <QuizSplit
                current={question?.id}
                numbers={
                  <QuestionNumbers
                    bookmarks
                    current={question?.id}
                    items={items}
                    onOpen={open}
                  />
                }
                onBack={() => undefined}
                onOpen={open}
                onQuestion
                phoneStrip={
                  <NumberStrip
                    current={question?.id}
                    items={items}
                    onOpen={open}
                    start={leave}
                  />
                }
                questions={questions}
              >
                <div className={TAKE_PANE}>
                  {question && (
                    <TakeQuestion
                      answers={answers}
                      key={question.id}
                      number={index + 1}
                      onChange={change}
                      question={question}
                    >
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        {/* Borderless (Epo 2026-11-25), pulled left by its
                            padding so the icon lines up with the question;
                            a marked one fills its icon, still in the text's
                            colour. */}
                        <Button
                          aria-pressed={bookmarks.includes(question.id)}
                          className="-ml-2.5 px-2.5"
                          iconLeft="bookmark"
                          iconLeftClassName={cn(
                            bookmarks.includes(question.id) &&
                              '[&_path]:fill-current'
                          )}
                          onClick={() => toggleBookmark(question.id)}
                          size="sm"
                          variant="ghost-hover"
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
                    </TakeQuestion>
                  )}
                </div>
              </QuizSplit>
            )}
            <div className="flex shrink-0 items-center gap-3 border-divider border-t px-4 py-2.5 md:hidden">
              {clock}
              <span className="ml-auto flex items-center gap-3">
                {!paper && savedState}
                {submitButton}
              </span>
            </div>
          </div>
          {/* The shared confirm (Epo 2026-11-25): its gap and accent Submit. */}
          <ConfirmDialog
            closeOnConfirm={false}
            confirmLabel={m.assignment_submit()}
            danger={false}
            disabled={uploading}
            isSubmitting={submitting}
            onClose={() => {
              setConfirming(false);
              setSubmitError(null);
            }}
            onConfirm={() => submit(true)}
            open={confirming}
            title={m.assignment_submit_confirm()}
          >
            {/* ConfirmDialog's body size, what is missing on the same line. */}
            <p className="text-[0.9375rem] sm:text-base">
              {confirmText}
              {confirmMissing && (
                <span className="text-tint-error-fg"> {confirmMissing}</span>
              )}
            </p>
            <FormAlert
              errorId={submitError?.errorId}
              message={submitError?.message ?? null}
            />
          </ConfirmDialog>
        </DrawingUploader.Provider>
      </DrawingDraftScope.Provider>
    </RemovedAssetsContext.Provider>
  );
}
