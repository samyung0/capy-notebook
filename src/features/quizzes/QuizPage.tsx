import { Link, type LinkOptions, linkOptions } from '@tanstack/react-router';
import type { CSSProperties, ReactNode } from 'react';
import type { Question, QuestionCredit } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
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

/** A breadcrumb segment; with a link it opens that page. */
export type Crumb = { label: string; link?: LinkOptions };

/** A block's first crumb: its workspace, or the Blocks tab when standalone. */
export const blockHomeCrumb = (block: {
  workspaceId: string;
  workspaceName: string;
}): Crumb =>
  block.workspaceId && block.workspaceName
    ? {
        label: block.workspaceName,
        link: linkOptions({
          params: { workspaceId: block.workspaceId },
          to: '/workspaces/$workspaceId',
        }),
      }
    : {
        label: m.files_tab_blocks(),
        link: linkOptions({ search: { tab: 'blocks' }, to: '/files' }),
      };

/** The Blocks tab filtered to one kind, e.g. every quiz. */
export const blockKindCrumb = (
  label: string,
  kind: 'quiz' | 'flashcards'
): Crumb => ({
  label,
  link: linkOptions({ search: { kind, tab: 'blocks' }, to: '/files' }),
});

/** Back arrow and breadcrumb above the page title; `actions` sit on the title line. */
export function QuizPageHeader({
  className,
  onBack,
  trail,
  title,
  meta,
  byline,
  actions,
  topBar,
}: {
  className?: string;
  onBack?: () => void;
  trail: Crumb[];
  title: ReactNode;
  meta?: ReactNode;
  /** The owner on public pages, between the title and the meta line. */
  byline?: ReactNode;
  actions?: ReactNode;
  /** The app's top bar, which from lg sits in PanelWithInvertedRadius's notch
   * beside this header; public pages have their own header and pass none. */
  topBar?: ReactNode;
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
            className={cn(
              'flex min-h-9 items-center',
              // Pulled left past the icon's padding, and from sm a further
              // 8px so arrow and text balance; phones keep the edge margin.
              onBack && '-ml-2 sm:-translate-x-2'
            )}
          >
            {onBack && (
              <IconButton
                className="rounded-input"
                icon="navigationBack"
                iconClassName="-translate-y-px"
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
                  {item.link ? (
                    <Link
                      {...item.link}
                      className={cn(
                        'truncate underline-offset-2 hover:text-fg hover:underline',
                        i === trail.length - 1 && 'text-fg-secondary'
                      )}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span
                      className={cn(
                        'truncate',
                        i === trail.length - 1 && 'text-fg-secondary'
                      )}
                    >
                      {item.label}
                    </span>
                  )}
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
        {byline}
        {/* Under a byline the meta belongs to the content below, so it sits
            further from the owner than the owner from the title. */}
        {meta && (
          <p className={cn('t-meta text-fg-muted', byline ? 'mt-2' : '-mt-1')}>
            {meta}
          </p>
        )}
      </div>
      {topBar}
    </header>
  );
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
  review?: boolean;
  disabled?: boolean;
  showAnswerKey?: boolean;
  /** Per-question actions under each question, e.g. Remove and Edit. */
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
 * A graded quiz's score, one square per question (each scrolls to its
 * question below) and marks by type; the confetti follows a fresh result.
 */
export function QuizScore({
  questions,
  awarded,
  max,
  confetti = false,
}: {
  /** Graded questions: every part carries the server's `awarded`. */
  questions: Question[];
  awarded: number;
  max: number;
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
          <ResultScore awarded={awarded} max={max} />
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
