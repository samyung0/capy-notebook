import { type Question, withoutBlanks } from '@/features/questions/types';
import { validateQuestion } from '@/features/questions/validation';
import { m } from '@/i18n';
import { CopyError } from '@/lib/errors';

/**
 * What an incomplete question lacks, as the line under it says (D4, Epo
 * 2026-10-10): learners see every question as typed, but only complete ones
 * are projected and marked. Null when the question is complete.
 */
export function incompleteLine(question: Question): string | null {
  const unanswered = question.parts.some(
    (part) =>
      (part.answer.type === 'mcq' || part.answer.type === 'multi') &&
      part.answer.correct.length === 0
  );
  if (unanswered)
    return m.quiz_incomplete({ reason: m.quiz_incomplete_correct() });
  try {
    validateQuestion(withoutBlanks(question));
    return null;
  } catch (error) {
    return m.quiz_incomplete({
      reason:
        error instanceof CopyError
          ? error.message
          : m.quiz_incomplete_generic(),
    });
  }
}
