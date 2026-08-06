import {
  QUIZ_REVIEW_OPTION_CLASS,
  QUIZ_REVIEW_OPTION_CORRECT_CLASS,
  QUIZ_REVIEW_OPTION_NEUTRAL_CLASS,
} from '@/features/notes/nodeStyles';
import { cn } from '@/lib/cn';

export type QuizOptionRole =
  | 'accepted-answer'
  | 'matching-pair'
  | 'ordering-item';

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
