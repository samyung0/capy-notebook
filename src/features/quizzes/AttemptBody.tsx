import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isAnonymousGradingLimit } from '@/api/anonymous';
import type { Provenance, Question } from '@/api/types';
import { TabContent } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { userToast } from '@/components/ui/userToast';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import type {
  LearnerPart,
  LearnerQuestion,
  QuestionPart,
} from '@/features/questions/types';
import { attemptMinutes } from '@/features/study/attempts';
import { m } from '@/i18n';
import { scoreBucket, track } from '@/lib/analytics';
import { toastSignInRequired } from '@/lib/authToasts';
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

/* Taking a quiz, shared by the app page and the public /share page. It knows
   no router or session: callers pass the frame, the top bar and how to grade. */

type Answers = Record<string, Answer>;
type AnyPart = LearnerPart | QuestionPart;

/** Whether an answer still means what the learner chose after an editor
 * changed the part live (D9, Epo 2026-10-10): a chosen option, ordering item
 * or matching option that is gone, or a changed number of gaps, drops it. */
function stillAnswers(before: AnyPart, after: AnyPart, value: Answer): boolean {
  const a = before.answer;
  const b = after.answer;
  if (a.type !== b.type) return false;
  if (a.type === 'mcq' && 'options' in b)
    return (
      Array.isArray(value) &&
      value.every(
        (i) =>
          typeof i === 'number' &&
          'options' in a &&
          a.options[i] === b.options[i]
      )
    );
  if (a.type === 'ordering' && 'items' in a && 'items' in b)
    return (
      [...a.items].sort().join('\u0000') === [...b.items].sort().join('\u0000')
    );
  if (
    b.type === 'matching' &&
    'options' in b &&
    value &&
    typeof value === 'object'
  )
    return Object.values(value).every((option) =>
      b.options.includes(option as string)
    );
  if (a.type === 'gaps' && b.type === 'gaps')
    return JSON.stringify(a) === JSON.stringify(b);
  return true;
}
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
  // Confetti greets a try finished here, not one reopened finished.
  const [celebrate, setCelebrate] = useState(false);
  const setAnswer = useCallback(
    (partId: string, value: Answer) =>
      setDrafts((current) => ({ ...current, [partId]: value })),
    []
  );
  // Questions update live under the learner (D9): answers that no longer
  // point at what the part holds go.
  const partsById = useMemo(
    () =>
      new Map<string, AnyPart>(
        questions.flatMap((question) =>
          question.parts.map((part) => [part.id, part] as const)
        )
      ),
    [questions]
  );
  const previousParts = useRef(partsById);
  useEffect(() => {
    const before = previousParts.current;
    previousParts.current = partsById;
    if (before === partsById) return;
    setDrafts((current) => {
      const kept = Object.fromEntries(
        Object.entries(current).filter(([id, value]) => {
          const was = before.get(id);
          const now = partsById.get(id);
          return !!(was && now && stillAnswers(was, now, value));
        })
      );
      return Object.keys(kept).length === Object.keys(current).length
        ? current
        : kept;
    });
  }, [partsById]);

  const checkedById = useMemo(
    () => new Map(run.checked.map((q) => [q.id, q] as const)),
    [run.checked]
  );
  const shown = questions.map((q) => checkedById.get(q.id) ?? q);
  const checkedCount = questions.filter((q) => checkedById.has(q.id)).length;
  const finished = questions.length > 0 && checkedCount === questions.length;
  const { awarded, max } = runScore(questions, run.checked);

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
          meta={quizMeta(questions)}
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
      finishedByCheck.current = checkedCount === questions.length - 1;
      await check(question.id, answers);
    } catch (err) {
      finishedByCheck.current = false;
      if (isAnonymousGradingLimit(err)) {
        toastSignInRequired(
          m.quiz_anonymous_limit_title(),
          m.quiz_anonymous_limit_body()
        );
        return;
      }
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
            questions={shown}
            review
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
          disabled={(question) => checking === question.id}
          onChange={setAnswer}
          questions={shown}
          renderAfter={(question) =>
            !checkedById.has(question.id) && (
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
                    : m.question_ui_check()}
                </Button>
              </div>
            )
          }
          review={(question) => checkedById.has(question.id)}
        />
        <p className="t-meta mt-12 text-fg-muted">
          {m.quiz_checked_count({
            checked: checkedCount,
            total: questions.length,
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
