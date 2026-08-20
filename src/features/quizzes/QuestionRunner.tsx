import type { ReactNode } from 'react';
import type { CognitiveLevel, Question, QuestionType } from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import {
  QUIZ_REVIEW_OPTION_CLASS,
  QUIZ_REVIEW_OPTION_CORRECT_CLASS,
  QUIZ_REVIEW_OPTION_NEUTRAL_CLASS,
  QUIZ_REVIEW_PROMPT_CLASS,
} from '@/features/notes/nodeStyles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { LEVEL_TONE, levelLabel } from '@/lib/levels';
import { type Answer, fuzzyMatch } from './grade';
import type { QuizOptionRole } from './quizOptionStyles';

export function QuestionRunner({
  question,
  answer,
  onChange,
  review = false,
  questionNumber,
  showExplanation = false,
}: {
  question: Question;
  answer: Answer;
  onChange: (a: Answer) => void;
  /** Read-only breakdown: interactions disabled, correct/incorrect surfaced. */
  review?: boolean;
  questionNumber?: number;
  showExplanation?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2">
        <Badge size="sm" tone={LEVEL_TONE[question.level]}>
          {levelLabel(question.level)}
        </Badge>
        {questionNumber != null && (
          <span className="t-subtitle">{questionNumber}.</span>
        )}
        <p className="t-subtitle flex-1">{question.prompt}</p>
      </div>

      {(question.type === 'mcq' || question.type === 'multi') && (
        <div className="flex flex-col gap-2">
          {question.options.map((opt, i) => {
            const selected = (answer as number[]).includes(i);
            const isCorrect = question.correct.includes(i);
            // Review tint: correct options green, wrongly-picked options red.
            const reviewTint = review
              ? isCorrect
                ? QUIZ_REVIEW_OPTION_CORRECT_CLASS
                : selected
                  ? 'border-solid-error bg-tint-error text-tint-error-fg'
                  : QUIZ_REVIEW_OPTION_NEUTRAL_CLASS
              : selected
                ? 'border-accent bg-tint-accent-1 text-fg'
                : 'border-line bg-surface text-fg hover:bg-surface-hover-bg';
            return (
              <button
                className={cn(
                  QUIZ_REVIEW_OPTION_CLASS,
                  'text-left',
                  review && 'cursor-default',
                  reviewTint
                )}
                disabled={review}
                key={i}
                onClick={() => {
                  if (review) return;
                  const cur = answer as number[];
                  if (question.type === 'mcq') onChange([i]);
                  else
                    onChange(
                      selected ? cur.filter((x) => x !== i) : [...cur, i]
                    );
                }}
                type="button"
              >
                <span className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full border',
                      review
                        ? isCorrect
                          ? 'border-solid-success bg-solid-success text-white'
                          : selected
                            ? 'border-solid-error bg-solid-error text-white'
                            : 'border-line-strong'
                        : selected
                          ? 'border-accent bg-action-accent text-action-accent-fg'
                          : 'border-line-strong'
                    )}
                  >
                    {review
                      ? (isCorrect || selected) && (
                          <Icon
                            name={isCorrect ? 'check' : 'x'}
                            size={13}
                            strokeWidth={2.5}
                          />
                        )
                      : selected && (
                          <Icon name="check" size={13} strokeWidth={2.5} />
                        )}
                  </span>
                  {opt.value}
                </span>
                {review && opt.explanation && (
                  <span className="pl-8 text-fg-muted text-xs">
                    {opt.explanation}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {question.type === 'boolean' && (
        <div className="flex gap-3">
          {[true, false].map((v) => {
            const selected = answer === v;
            const isCorrect = question.correct === v;
            const reviewTint = review
              ? isCorrect
                ? 'border-solid-success bg-tint-success'
                : selected
                  ? 'border-solid-error bg-tint-error'
                  : 'border-line bg-surface'
              : selected
                ? 'border-accent bg-tint-accent-1'
                : 'border-line bg-surface hover:bg-surface-hover-bg';
            return (
              <button
                className={cn(
                  'flex-1 rounded-card border px-4 py-3 font-semibold text-sm transition-colors',
                  review && 'cursor-default',
                  reviewTint
                )}
                disabled={review}
                key={String(v)}
                onClick={() => !review && onChange(v)}
                type="button"
              >
                {v ? 'True' : 'False'}
              </button>
            );
          })}
        </div>
      )}

      {question.type === 'short' && (
        <div className="flex flex-col gap-2">
          <input
            className={cn(
              'rounded-button border bg-surface px-3 py-2.5 text-fg text-sm outline-none',
              review
                ? question.accepted.some((a) =>
                    fuzzyMatch(a.value, (answer as string) ?? '')
                  )
                  ? 'border-solid-success'
                  : 'border-solid-error'
                : 'border-line focus:border-line-strong'
            )}
            onChange={(e) => !review && onChange(e.target.value)}
            placeholder={review ? '(no answer)' : 'Type your answer'}
            readOnly={review}
            value={answer as string}
          />
          {review && (
            <p className="t-meta text-fg-muted">
              Accepted: {question.accepted.map((a) => a.value).join(', ')}
            </p>
          )}
        </div>
      )}

      {question.type === 'open' && (
        <div className="flex flex-col gap-2">
          <textarea
            className={cn(
              'min-h-28 rounded-button border bg-surface px-3 py-2.5 text-fg text-sm outline-none',
              review
                ? question.awarded != null && question.awarded > 0
                  ? 'border-solid-success'
                  : 'border-solid-error'
                : 'border-line focus:border-line-strong'
            )}
            onChange={(e) => !review && onChange(e.target.value)}
            placeholder={review ? '(no answer)' : m.quiz_open_placeholder()}
            readOnly={review}
            value={answer as string}
          />
          {review && (
            <div className="flex flex-col gap-1">
              {question.awardReason && (
                <p className="t-meta text-fg-muted">{question.awardReason}</p>
              )}
              <p className="t-meta text-fg-muted">
                {m.quiz_model_answer()}:{' '}
                {question.accepted.map((a) => a.value).join(' ')}
              </p>
            </div>
          )}
        </div>
      )}

      {question.type === 'ordering' && (
        <div className="flex flex-col gap-2">
          {(answer as string[]).map((item, i) => {
            const correctHere = review && question.items[i]?.value === item;
            return (
              <div
                className={cn(
                  'flex items-center gap-2 rounded-card border px-3 py-2 text-sm',
                  review
                    ? correctHere
                      ? 'border-solid-success bg-tint-success'
                      : 'border-solid-error bg-tint-error'
                    : 'border-line bg-surface'
                )}
                key={item}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-hover-bg font-bold text-fg-secondary text-xs">
                  {i + 1}
                </span>
                <span className="flex-1">{item}</span>
                {!review && (
                  <>
                    <button
                      className="text-fg-muted disabled:opacity-30"
                      disabled={i === 0}
                      onClick={() => {
                        const a = [...(answer as string[])];
                        [a[i - 1], a[i]] = [a[i], a[i - 1]];
                        onChange(a);
                      }}
                      type="button"
                    >
                      <Icon
                        name="chevronLeft"
                        size={16}
                        style={{ transform: 'rotate(90deg)' }}
                      />
                    </button>
                    <button
                      className="text-fg-muted disabled:opacity-30"
                      disabled={i === (answer as string[]).length - 1}
                      onClick={() => {
                        const a = [...(answer as string[])];
                        [a[i + 1], a[i]] = [a[i], a[i + 1]];
                        onChange(a);
                      }}
                      type="button"
                    >
                      <Icon
                        name="chevronRight"
                        size={16}
                        style={{ transform: 'rotate(90deg)' }}
                      />
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {review && (
            <p className="t-meta text-fg-muted">
              Correct order: {question.items.map((it) => it.value).join(' → ')}
            </p>
          )}
        </div>
      )}

      {question.type === 'matching' && (
        <div className="flex flex-col gap-2">
          {question.pairs.map((p) => {
            const chosen = (answer as Record<string, string>)[p.left] ?? '';
            const ok = review && chosen === p.right;
            return (
              <div className="flex items-center gap-3" key={p.left}>
                <span className="w-1/2 font-medium text-fg text-sm">
                  {p.left}
                </span>
                <select
                  className={cn(
                    'w-1/2 rounded-button border bg-surface px-2 py-2 text-fg text-sm',
                    review
                      ? ok
                        ? 'border-solid-success'
                        : 'border-solid-error'
                      : 'border-line'
                  )}
                  disabled={review}
                  onChange={(e) =>
                    !review &&
                    onChange({
                      ...(answer as Record<string, string>),
                      [p.left]: e.target.value,
                    })
                  }
                  value={chosen}
                >
                  <option value="">Choose…</option>
                  {question.pairs.map((opt) => (
                    <option key={opt.right} value={opt.right}>
                      {opt.right}
                    </option>
                  ))}
                </select>
                {review && !ok && (
                  <p className="t-meta whitespace-nowrap text-fg-muted">
                    → {p.right}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showExplanation && question.explanation && (
        <p className="t-meta border-divider border-t pt-3 text-fg-muted">
          {question.explanation}
        </p>
      )}
    </div>
  );
}

export function QuizQuestionHeader({
  questionNumber,
  level,
}: {
  questionNumber?: number;
  questionType: QuestionType;
  level: CognitiveLevel;
}) {
  return (
    <div className="mb-3 flex items-center gap-2" contentEditable={false}>
      <Badge className="-translate-y-px" size="sm" tone={LEVEL_TONE[level]}>
        {levelLabel(level)}
      </Badge>
      <div className={cn(QUIZ_REVIEW_PROMPT_CLASS, 'mb-0')}>
        {questionNumber}.
      </div>
    </div>
  );
}

export function QuizOptionView({
  children,
  correct,
  role,
  optionNumber,
  explanation,
}: {
  children: ReactNode;
  correct: boolean;
  role?: QuizOptionRole;
  optionNumber?: number;
  explanation?: string;
}) {
  const highlighted = correct || role === 'accepted-answer';
  const orderedItem = role === 'ordering-item';
  const matchingPair = role === 'matching-pair';

  return (
    <>
      <span className="flex items-center gap-3">
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
            highlighted
              ? 'border-solid-success bg-solid-success text-white'
              : orderedItem
                ? 'border-0 bg-surface-hover-bg font-bold text-fg-secondary text-xs'
                : matchingPair
                  ? 'border-line-strong text-fg-muted'
                  : 'border-line-strong'
          )}
          contentEditable={false}
        >
          {highlighted ? (
            <Icon name="check" size={13} strokeWidth={2.5} />
          ) : orderedItem ? (
            optionNumber
          ) : matchingPair ? (
            '↔'
          ) : null}
        </span>
        <span className="wrap-break-word min-w-0">{children}</span>
      </span>
      {explanation && (
        <span className="pl-8 text-fg-muted text-xs" contentEditable={false}>
          {explanation}
        </span>
      )}
    </>
  );
}
