import { type ReactNode, useCallback, useState } from 'react';
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
import { m } from '@/i18n';
import { scoreBucket, track } from '@/lib/analytics';
import { toastSignInRequired } from '@/lib/authToasts';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import type { Answer } from './grade';
import { isAnswered } from './QuestionRunner';
import {
  type Crumb,
  QuizPageHeader,
  QuizQuestionList,
  QuizScore,
  quizMeta,
} from './QuizPage';

/* Taking a quiz, shared by the app page and the public /share page. It knows
   no router or session: callers pass the frame, the top bar and how to grade. */

type Answers = Record<string, Answer>;
const EmbeddedBody = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);
/** The panel around the page; its header stays put while the body scrolls. */
export type Frame = (props: {
  children: ReactNode;
  header?: ReactNode;
}) => ReactNode;
export const NoFrame: Frame = ({ children }) => children;
/** An attempt graded on the server: its questions with their keys and each
 * part's award, and the marks over the quiz's total. */
export type Graded = { questions: Question[]; awarded: number; max: number };

export function AttemptBody({
  actions,
  byline,
  embedded,
  emptyAction,
  footer,
  frame,
  grade,
  name,
  onBack,
  onGraded,
  provenance,
  questions,
  topBar,
  trail,
}: {
  actions?: ReactNode;
  /** The owner, on shared links. */
  byline?: ReactNode;
  /** Inside a note: no header, frame or page padding; the note around it
   * names nothing, so the quiz starts at its first question. */
  embedded?: boolean;
  /** Under the empty-quiz message, e.g. the app's way back to Files. */
  emptyAction?: ReactNode;
  footer?: ReactNode;
  /** The surrounding panel; the result view remounts it to open at the top.
   * Embedded quizzes have none. */
  frame?: Frame;
  /** Grades every part on the server; signed in, this also records the attempt. */
  grade: (answers: Answers) => Promise<Graded>;
  name: string;
  onBack?: () => void;
  /** After grading, e.g. to keep a signed-out attempt in this browser. */
  onGraded?: (answers: Answers, graded: Graded) => void;
  provenance?: Provenance;
  /** Answer-free: the key arrives with the graded attempt. */
  questions: (Question | LearnerQuestion)[];
  /** The app's top bar. Public pages pass none: their ⋮ stays on every state
   * and the title sits higher, with no label row above it. */
  topBar?: ReactNode;
  trail: Crumb[];
}) {
  const Shell = frame ?? NoFrame;
  const Body = embedded ? EmbeddedBody : TabContent;
  const [answers, setAnswers] = useState<Answers>({});
  const [graded, setGraded] = useState<Graded | null>(null);
  const [grading, setGrading] = useState(false);
  const setAnswer = useCallback(
    (partId: string, value: Answer) =>
      setAnswers((current) => ({ ...current, [partId]: value })),
    []
  );

  // Public pages keep their ⋮ on every state; the app page shows Clone only
  // while taking the quiz.
  const header = (headerActions = topBar ? undefined : actions) =>
    !embedded && (
      <QuizPageHeader
        actions={headerActions}
        byline={byline}
        className={topBar ? undefined : 'pt-2 sm:pt-2'}
        meta={quizMeta(questions)}
        onBack={onBack}
        title={name}
        topBar={topBar}
        trail={trail}
      />
    );

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

  async function finish() {
    setGrading(true);
    try {
      const result = await grade(answers);
      const pct = result.max > 0 ? (result.awarded / result.max) * 100 : 0;
      track('quiz_attempt_finished', { scoreBucket: scoreBucket(pct) });
      setGraded(result);
      onGraded?.(answers, result);
    } catch (err) {
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
      setGrading(false);
    }
  }

  if (graded) {
    return (
      // A fresh panel so the result opens at the top, not at the quiz's scroll.
      <Shell header={header()} key="result">
        <Body>
          {/* Inside a note the score would push the note down; each question
              shows its own result. */}
          {!embedded && (
            <QuizScore
              awarded={graded.awarded}
              confetti
              max={graded.max}
              questions={graded.questions}
            />
          )}
          <QuizQuestionList
            answers={answers}
            className={cn(embedded ? 'gap-10' : 'mt-12')}
            credits={provenance?.questions}
            questions={graded.questions}
            review
          />
          {/* Sized like the quiz editor's Edit and Remove. */}
          <div className="mt-12 flex justify-end">
            <Button
              className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
              iconLeft="refresh"
              iconLeftClassName="size-3.5 sm:size-3.75"
              onClick={() => {
                setAnswers({});
                setGraded(null);
              }}
              rounded="large"
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

  const parts = questions.flatMap(
    (q): (QuestionPart | LearnerPart)[] => q.parts
  );
  // An ordering part always counts: its shown order is the answer, and the
  // shown order may already be the right one.
  const answered = parts.filter(
    (part) => part.answer.type === 'ordering' || isAnswered(answers[part.id])
  ).length;

  return (
    <Shell header={header(actions)}>
      <Body>
        <QuizQuestionList
          answers={answers}
          className={cn(embedded && 'gap-10')}
          credits={provenance?.questions}
          onChange={setAnswer}
          questions={questions}
        />
        {/* Inside a note Submit is a small accent button beside the count,
            sized like the flashcards' Previous and Next. */}
        <div
          className={cn(
            'mt-12',
            embedded ? 'flex items-center justify-between gap-3' : 'grid gap-3'
          )}
        >
          <p className="t-meta text-fg-muted">
            {m.quiz_answered_count({ answered, total: parts.length })}
          </p>
          <Button
            disabled={grading}
            fullWidth={!embedded}
            onClick={() => void finish()}
            rounded={embedded ? undefined : 'large'}
            size={embedded ? 'sm' : 'lg'}
            variant={embedded ? 'accent' : 'dark'}
          >
            {grading ? m.quiz_grading() : m.quiz_submit()}
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
