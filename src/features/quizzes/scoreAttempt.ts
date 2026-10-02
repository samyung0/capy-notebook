import type { GradedPart, Question, QuestionPart } from '@/api/types';
import {
  type Answers,
  applyItemAwards,
  scorePart,
  scoreQuestion,
  sumScores,
} from './grade';

/** Grades open answers on the server, keyed by part id. */
export type GradeOpenParts = (
  answers: Record<string, string>
) => Promise<Record<string, GradedPart>>;

/** Scores closed parts in the browser and sends every answered open part in
 * one grading request; blank open answers earn 0 without a request. */
export async function gradeAttemptQuestions(
  questions: Question[],
  answers: Answers,
  gradeOpen: GradeOpenParts
): Promise<{ questions: Question[]; awarded: number; max: number }> {
  const open: Record<string, string> = {};
  for (const part of questions.flatMap((question) => question.parts)) {
    const answer = answers[part.id];
    if (
      part.answer.type === 'open' &&
      typeof answer === 'string' &&
      answer.trim()
    )
      open[part.id] = answer;
  }
  const graded = Object.keys(open).length ? await gradeOpen(open) : {};
  const next = questions.map((question) => ({
    ...question,
    parts: question.parts.map(
      (part): QuestionPart =>
        part.answer.type === 'open'
          ? applyItemAwards(part, graded[part.id]?.itemAwards)
          : { ...part, awarded: scorePart(part, answers[part.id]).awarded }
    ),
  }));
  return {
    ...sumScores(next.map((q) => scoreQuestion(q, answers))),
    questions: next,
  };
}
