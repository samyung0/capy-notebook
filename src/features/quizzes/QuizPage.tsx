import type { CSSProperties, ReactNode } from 'react';
import type { Question, QuestionCredit } from '@/api/types';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { QuestionCreditNote } from '@/features/materials/MaterialAttributionFooter';
import { questionMarks } from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { type Answers, formatPoints, scoreQuestion } from './grade';
import { QuestionRunner } from './QuestionRunner';

/** "10 questions · 12 marks". */
export function quizMeta(questions: Question[]) {
  const marks = questions.reduce((sum, q) => sum + questionMarks(q), 0);
  return `${
    questions.length === 1
      ? m.question_ui_one_question()
      : m.question_ui_question_count({ count: questions.length })
  } · ${
    marks === 1
      ? m.question_ui_one_mark()
      : m.question_ui_marks({ count: marks })
  }`;
}

/** Back arrow and breadcrumb above the page title; `actions` sit on the title line. */
export function QuizPageHeader({
  className,
  onBack,
  trail,
  title,
  meta,
  actions,
  topBar = true,
}: {
  className?: string;
  onBack?: () => void;
  trail: string[];
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** From lg the top bar sits in PanelWithInvertedRadius's notch, beside this header. */
  topBar?: boolean;
}) {
  return (
    <header className="flex items-start">
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-2 px-4 pt-4 sm:px-6 sm:pt-6 lg:px-10 xl:px-16',
          className
        )}
      >
        {(onBack || trail.length > 0) && (
          <div
            className={cn('flex min-h-9 items-center gap-1', onBack && '-ml-2')}
          >
            {onBack && (
              <IconButton
                className="rounded-input"
                icon="navigationBack"
                label={m.action_back()}
                onClick={onBack}
                size="sm"
                variant="ghost-hover"
              />
            )}
            <nav
              aria-label={m.quiz_breadcrumb()}
              className="t-meta flex min-w-0 items-center gap-1.5 text-fg-muted"
            >
              {trail.map((item, i) => (
                <span className="flex min-w-0 items-center gap-1.5" key={i}>
                  {i > 0 && <span aria-hidden>/</span>}
                  <span
                    className={cn(
                      'truncate',
                      i === trail.length - 1 && 'text-fg-secondary'
                    )}
                  >
                    {item}
                  </span>
                </span>
              ))}
            </nav>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <h1 className="t-page-title min-w-0 truncate">{title}</h1>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
        {meta && <p className="t-meta -mt-1 text-fg-muted">{meta}</p>}
      </div>
      {topBar && <TopInsetBar className="hidden shrink-0 lg:flex" />}
    </header>
  );
}

/** Every question of a quiz on one page. */
export function QuizQuestionList({
  questions,
  answers = {},
  onChange,
  review,
  disabled,
  showAnswerKey,
  renderAfter,
  credits,
}: {
  questions: Question[];
  answers?: Answers;
  onChange?: (partId: string, value: Answers[string]) => void;
  review?: boolean;
  disabled?: boolean;
  showAnswerKey?: boolean;
  /** Per-question actions under each question, e.g. Remove and Edit. */
  renderAfter?: (question: Question, index: number) => ReactNode;
  /** Bank credits of copied questions, by question id (the quiz's provenance). */
  credits?: Record<string, QuestionCredit> | null;
}) {
  return (
    <ol className="grid gap-12">
      {questions.map((question, i) => (
        <li
          className="grid scroll-mt-6 gap-4"
          data-question-id={question.id}
          key={question.id}
        >
          <QuestionRunner
            answers={answers}
            disabled={disabled}
            onChange={onChange}
            question={question}
            questionNumber={i + 1}
            review={review}
            showAnswerKey={showAnswerKey}
          />
          <QuestionCreditNote credit={credits?.[question.id]} />
          {renderAfter?.(question, i)}
        </li>
      ))}
    </ol>
  );
}

const CONFETTI = [
  ['-22px', '-26px', 'var(--color-solid-accent-1)', '40deg'],
  ['-4px', '-34px', 'var(--color-solid-warning)', '-30deg'],
  ['16px', '-28px', 'var(--color-solid-success)', '80deg'],
  ['26px', '-8px', 'var(--color-solid-info)', '-70deg'],
  ['24px', '14px', 'var(--color-solid-error)', '15deg'],
  ['-26px', '-4px', 'var(--color-solid-accent-2)', '-50deg'],
];

function Confetti() {
  return (
    <span
      aria-hidden
      className="relative inline-grid size-9 place-items-center"
    >
      <Icon
        className="motion-confetti-pop text-solid-accent-1"
        name="partyPopper"
        size={30}
      />
      {CONFETTI.map(([dx, dy, color, r]) => (
        <span
          className="motion-confetti-burst absolute top-1/2 left-1/2 size-2 rounded-[2px]"
          key={dx + dy}
          style={
            {
              '--dx': dx,
              '--dy': dy,
              '--r': r,
              background: color,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

/**
 * "You scored" at title size with the score beside it; the confetti follows
 * on a fresh result. Below lg the score takes its own line.
 */
export function QuizScore({
  questions,
  answers,
  awarded,
  max,
  confetti = false,
}: {
  questions: Question[];
  answers: Answers;
  awarded: number;
  max: number;
  confetti?: boolean;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <h2 className="t-page-title">{m.quiz_you_scored_title()}</h2>
        <p className="order-last w-full font-bold text-2xl text-fg-secondary tabular-nums lg:order-none lg:w-auto">
          {formatPoints(awarded)}
          <span className="text-fg-muted"> / {formatPoints(max)}</span>
        </p>
        {confetti && <Confetti />}
      </div>
      <ResultSquares answers={answers} questions={questions} />
    </div>
  );
}

/** One square per question: green for full marks, red otherwise (blank answers are wrong). */
function ResultSquares({
  questions,
  answers,
}: {
  questions: Question[];
  answers: Answers;
}) {
  return (
    <ol aria-label={m.quiz_question_results()} className="flex flex-wrap gap-1">
      {questions.map((question, i) => {
        const score = scoreQuestion(question, answers);
        const right = score.max > 0 && score.awarded === score.max;
        const label = right
          ? m.quiz_question_right({ number: i + 1 })
          : m.quiz_question_wrong({ number: i + 1 });
        return (
          <li
            aria-label={label}
            className={cn(
              'size-3.5 rounded-[4px]',
              right ? 'bg-solid-success' : 'bg-solid-error'
            )}
            key={question.id}
            title={label}
          />
        );
      })}
    </ol>
  );
}
