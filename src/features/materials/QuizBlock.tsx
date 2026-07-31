import type { ReactNode } from 'react';
import type { CognitiveLevel, QuestionType } from '@/api/types';
import { Badge, Icon } from '@/components/ui';
import {
  QUIZ_REVIEW_OPTION_CLASS,
  QUIZ_REVIEW_OPTION_CORRECT_CLASS,
  QUIZ_REVIEW_OPTION_NEUTRAL_CLASS,
  QUIZ_REVIEW_PROMPT_CLASS,
} from '@/features/notes/nodeStyles';
import { cn } from '@/lib/cn';
import { LEVEL_LABEL, LEVEL_TONE } from '@/lib/levels';

export type QuizOptionRole =
  | 'accepted-answer'
  | 'matching-pair'
  | 'ordering-item';

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
        {LEVEL_LABEL[level]}
      </Badge>
      <div className={cn(QUIZ_REVIEW_PROMPT_CLASS, 'mb-0')}>
        {questionNumber}.
      </div>
    </div>
  );
}

export function quizOptionClassName(
  correct: boolean,
  role?: QuizOptionRole
): string {
  return cn(
    'col-span-2',
    QUIZ_REVIEW_OPTION_CLASS,
    correct || role === 'accepted-answer'
      ? QUIZ_REVIEW_OPTION_CORRECT_CLASS
      : QUIZ_REVIEW_OPTION_NEUTRAL_CLASS
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
