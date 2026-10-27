import type { CSSProperties, ReactNode } from 'react';
import type { Question, QuestionCredit } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { QuestionCreditNote } from '@/features/materials/MaterialAttributionFooter';
import {
  type LearnerQuestion,
  questionMarks,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { Answers } from './grade';
import { QuestionRunner } from './QuestionRunner';
import {
  type QuestionResult,
  ResultScore,
  ResultSquares,
  ResultsByType,
} from './ResultSummary';

/** "10 questions · 12 marks". */
export function quizMeta(questions: (Question | LearnerQuestion)[]) {
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

/** Every question of a quiz on one page. Learner questions (no answer key)
 * render for taking and viewing; review needs the graded questions. */
export function QuizQuestionList<Q extends Question | LearnerQuestion>({
  questions,
  answers = {},
  onChange,
  review,
  disabled,
  showAnswerKey,
  renderAfter,
  credits,
  className,
}: {
  questions: Q[];
  answers?: Answers;
  onChange?: (partId: string, value: Answers[string]) => void;
  /** All questions, or per question (a quiz checked one question at a time). */
  review?: boolean | ((question: Q) => boolean);
  disabled?: boolean | ((question: Q) => boolean);
  showAnswerKey?: boolean;
  /** Per-question content under each question. */
  renderAfter?: (question: Q, index: number) => ReactNode;
  /** Bank credits of copied questions, by question id (the quiz's provenance). */
  credits?: Record<string, QuestionCredit> | null;
  className?: string;
}) {
  return (
    <ol className={cn('grid gap-12', className)}>
      {questions.map((question, i) => (
        <li
          className="grid scroll-mt-6 gap-4"
          data-question-id={question.id}
          key={question.id}
        >
          <QuestionRunner
            answers={answers}
            disabled={
              typeof disabled === 'function' ? disabled(question) : disabled
            }
            onChange={onChange}
            question={question}
            questionNumber={i + 1}
            review={typeof review === 'function' ? review(question) : review}
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
 * A graded quiz's score, one square per question (each scrolls to its
 * question below) and marks by type; the confetti follows a fresh result.
 */
export function QuizScore({
  questions,
  awarded,
  max,
  minutes,
  confetti = false,
}: {
  /** Graded questions: every part carries the server's `awarded`. */
  questions: Question[];
  awarded: number;
  max: number;
  /** "12 min" beside the score; absent where the start is unknown. */
  minutes?: string;
  confetti?: boolean;
}) {
  const results = questions.map(
    (question, i): QuestionResult => ({
      awarded: question.parts.reduce(
        (sum, part) => sum + (part.awarded ?? 0),
        0
      ),
      id: question.id,
      marks: questionMarks(question),
      number: i + 1,
      type: question.parts[0].answer.type,
    })
  );
  return (
    <div className="grid gap-8">
      <div className="grid gap-3">
        <div className="flex items-center gap-4">
          <ResultScore awarded={awarded} max={max} minutes={minutes} />
          {confetti && <Confetti />}
        </div>
        <ResultSquares
          onOpen={(id) =>
            document
              .querySelector(`[data-question-id="${CSS.escape(id)}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
          results={results}
        />
      </div>
      <ResultsByType results={results} />
    </div>
  );
}
