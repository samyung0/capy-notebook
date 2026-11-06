import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isNoAnswersError } from '@/api/client';
import type { Provenance, Question } from '@/api/types';
import { TabContent } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { userToast } from '@/components/ui/userToast';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import type { LearnerQuestion } from '@/features/questions/types';
import { attemptMinutes } from '@/features/study/attempts';
import { m } from '@/i18n';
import { scoreBucket, track } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { type Answer, runScore } from './grade';
import { QuizQuestionList, QuizScore, quizMeta } from './QuizPage';
import {
  type Crumb,
  type Frame,
  NoFrame,
  QuizPageHeader,
} from './QuizPageHeader';
import type { QuizRunControl } from './quizRun';
import { ResetButton } from './ResetButton';
import { keptAnswers, partsById } from './stillAnswers';

/* Taking a quiz, shared by the app page and the public /share page. It knows
   no router or session: callers pass the frame, the top bar and how to grade. */

type Answers = Record<string, Answer>;
/** In place of a question's Check, under a question with no answers. */
const NoAnswersLine = () => (
  <p className="t-meta text-right text-fg-muted">
    {m.quiz_no_answers_configured()}
  </p>
);

const EmbeddedBody = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);
/** A page's body, running to the wide gutter. */
const WideBody = ({ children }: { children: ReactNode }) => (
  <TabContent fill>{children}</TabContent>
);
export function AttemptBody({
  actions,
  byline,
  control,
  embedded,
  emptyAction,
  footer,
  frame,
  name,
  neverMarks = false,
  onBack,
  provenance,
  questions,
  inApp = false,
  trail,
}: {
  actions?: ReactNode;
  /** The owner, on shared links. */
  byline?: ReactNode;
  /** The try in progress and how a question is checked: on the account,
   * in this browser or only on the page (quizRun.ts). */
  control: QuizRunControl;
  /** Inside a note: no header, frame or page padding; the note around it
   * names nothing, so the quiz starts at its first question. */
  embedded?: boolean;
  /** Under the empty-quiz message, e.g. the app's way back to Files. */
  emptyAction?: ReactNode;
  footer?: ReactNode;
  /** The surrounding panel; the result view remounts it to open at the top.
   * Embedded quizzes have none. */
  frame?: Frame;
  name: string;
  /** A shared page: open answers stay Not marked there, so checking one again
   * would change nothing. */
  neverMarks?: boolean;
  onBack?: () => void;
  provenance?: Provenance;
  /** Answer-free: each key arrives with its checked question. */
  questions: (Question | LearnerQuestion)[];
  /** The app's page. Public pages leave it off: their ⋮ stays on every state
   * and the title sits higher, with no label row above it. */
  inApp?: boolean;
  trail: Crumb[];
}) {
  const Shell = frame ?? NoFrame;
  const Body = embedded ? EmbeddedBody : WideBody;
  const { run, check, redo } = control;
  // Answers typed into questions not yet checked; a checked question shows
  // the answers it was checked with.
  const [drafts, setDrafts] = useState<Answers>({});
  // The question being checked: one at a time, so each check builds on the
  // run the page shows.
  const [checking, setChecking] = useState<string | null>(null);
  // Questions a check found with no answers (Epo 2026-11-05): they say so, and
  // neither finish nor score counts them.
  const [noAnswers, setNoAnswers] = useState<ReadonlySet<string>>(new Set());
  // Confetti greets a try finished here, not one reopened finished.
  const [celebrate, setCelebrate] = useState(false);
  const setAnswer = useCallback(
    (partId: string, value: Answer) =>
      setDrafts((current) => ({ ...current, [partId]: value })),
    []
  );
  // Questions update live under the learner (D9): answers that no longer
  // point at what the part holds go.
  const parts = useMemo(() => partsById(questions), [questions]);
  const previousParts = useRef(parts);
  useEffect(() => {
    const before = previousParts.current;
    previousParts.current = parts;
    if (before !== parts)
      setDrafts((current) => keptAnswers(before, parts, current));
  }, [parts]);

  const checkedById = useMemo(
    () => new Map(run.checked.map((q) => [q.id, q] as const)),
    [run.checked]
  );
  const shown = questions.map((q) => checkedById.get(q.id) ?? q);
  const answerable = questions.filter((q) => !noAnswers.has(q.id));
  const checkedCount = answerable.filter((q) => checkedById.has(q.id)).length;
  const finished = checkedCount > 0 && checkedCount === answerable.length;
  const { awarded, max } = runScore(answerable, run.checked);

  // The try finishes with the check of its last question, not on a page
  // that opens it already finished.
  const finishedByCheck = useRef(false);
  useEffect(() => {
    if (!finished || !finishedByCheck.current) return;
    finishedByCheck.current = false;
    setCelebrate(true);
    const pct = max > 0 ? (awarded / max) * 100 : 0;
    track('quiz_attempt_finished', { scoreBucket: scoreBucket(pct) });
  }, [finished, awarded, max]);

  function restart() {
    setDrafts({});
    setCelebrate(false);
    redo();
  }

  // Public pages keep their ⋮ on every state; the app page shows Clone only
  // while taking the quiz. While taking it, Reset sits at the far right once
  // a question is checked; the result has Redo quiz instead.
  const header = (
    headerActions = inApp ? undefined : actions,
    taking = false
  ) => {
    const reset = taking && run.checked.length > 0;
    return (
      !embedded && (
        <QuizPageHeader
          actions={
            (headerActions || reset) && (
              <>
                {headerActions}
                {reset && (
                  <ResetButton disabled={checking !== null} onClick={restart} />
                )}
              </>
            )
          }
          byline={byline}
          className={inApp ? undefined : 'pt-4 sm:pt-2'}
          meta={quizMeta(answerable)}
          onBack={onBack}
          title={name}
          trail={trail}
        />
      )
    );
  };

  if (!questions.length) {
    return (
      <Shell header={header()}>
        <Body>
          <p className="text-fg-muted">{m.quiz_no_questions()}</p>
          {emptyAction}
        </Body>
      </Shell>
    );
  }

  async function checkQuestion(question: Question | LearnerQuestion) {
    const own = new Set(question.parts.map((part) => part.id));
    const answers = Object.fromEntries(
      Object.entries(drafts).filter(([id]) => own.has(id))
    );
    setChecking(question.id);
    try {
      finishedByCheck.current =
        !checkedById.has(question.id) && checkedCount === answerable.length - 1;
      await check(question.id, answers);
    } catch (err) {
      if (isNoAnswersError(err)) {
        setNoAnswers((current) => new Set(current).add(question.id));
        return;
      }
      finishedByCheck.current = false;
      userToast({
        description: errorCopy(err, m.quiz_grade_failed_body()),
        title: m.quiz_grade_failed(),
        variant: 'error',
      });
    } finally {
      setChecking(null);
    }
  }

  const answers = { ...drafts, ...run.answers };

  if (finished) {
    return (
      // A fresh panel so the result opens at the top, not at the quiz's scroll.
      <Shell header={header()} key="result">
        <Body>
          {/* Inside a note the score would push the note down; each question
              shows its own result. */}
          {!embedded && (
            <QuizScore
              awarded={awarded}
              confetti={celebrate}
              leftOut={noAnswers}
              max={max}
              minutes={
                run.takenAt
                  ? attemptMinutes({
                      startedAt: run.startedAt,
                      takenAt: run.takenAt,
                    })
                  : undefined
              }
              questions={shown as Question[]}
            />
          )}
          <QuizQuestionList
            answers={answers}
            className={cn(embedded ? 'gap-10' : 'mt-12')}
            credits={provenance?.questions}
            disabled={(question) => noAnswers.has(question.id)}
            questions={shown}
            renderAfter={(question) =>
              noAnswers.has(question.id) && <NoAnswersLine />
            }
            review={(question) => !noAnswers.has(question.id)}
          />
          {/* Sized like the quiz editor's Edit and Remove. */}
          <div className="mt-12 flex justify-end">
            <Button
              className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
              iconLeft="refresh"
              onClick={restart}
              rounded="normal"
              size="sm"
              variant="outline"
            >
              {m.quiz_redo()}
            </Button>
          </div>
          {footer}
          <SourcesLine
            className={embedded ? 'mt-3' : 'mt-16 pb-4'}
            provenance={provenance}
          />
        </Body>
      </Shell>
    );
  }

  return (
    <Shell header={header(actions, true)}>
      <Body>
        <QuizQuestionList
          answers={answers}
          className={cn(embedded && 'gap-10')}
          credits={provenance?.questions}
          disabled={(question) =>
            checking === question.id || noAnswers.has(question.id)
          }
          onChange={setAnswer}
          questions={shown}
          renderAfter={(question) =>
            noAnswers.has(question.id) ? (
              <NoAnswersLine />
            ) : (
              // Not marked (no credits, a failure) can be checked again.
              (!checkedById.has(question.id) ||
                (!neverMarks &&
                  checkedById
                    .get(question.id)
                    ?.parts.some((p) => p.pending))) && (
                <div className="flex justify-end">
                  {/* Sized like the review session's Check. */}
                  <Button
                    className="h-9 px-3.5"
                    disabled={checking !== null}
                    onClick={() => void checkQuestion(question)}
                    rounded="normal"
                    size="sm"
                  >
                    {checking === question.id
                      ? m.quiz_grading()
                      : checkedById.has(question.id)
                        ? m.question_ui_check_again()
                        : m.question_ui_check()}
                  </Button>
                </div>
              )
            )
          }
          review={(question) => checkedById.has(question.id)}
        />
        <p className="t-meta mt-12 text-fg-muted">
          {m.quiz_checked_count({
            checked: checkedCount,
            total: answerable.length,
          })}
        </p>
        {footer}
        <SourcesLine
          className={embedded ? 'mt-3' : 'mt-16 pb-4'}
          provenance={provenance}
        />
      </Body>
    </Shell>
  );
}
