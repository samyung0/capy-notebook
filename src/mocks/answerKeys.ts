import {
  type LearnerAnswer,
  type LearnerQuestion,
  multipleAnswers,
  type Question,
  type QuestionPart,
  shuffledOrder,
} from '@/features/questions/types';
import { partAnswer } from '@/features/quizzes/drawing/canvasParts';
import { isDrawingValue } from '@/features/quizzes/drawing/drawingValue';
import {
  type Answer,
  type Answers,
  applyItemAwards,
  scorePart,
} from '@/features/quizzes/grade';

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Mirrors the server's `questions.LearnerView`: no answers, marking schemes
 * or solutions, with matching options, ordering items and Shuffle options'
 * mcq options (`order`) shuffled. */
export function learnerView(question: Question): LearnerQuestion {
  return {
    ...question,
    parts: question.parts.map((part) => {
      const answer = part.answer;
      let learner: LearnerAnswer;
      switch (answer.type) {
        case 'mcq':
          learner = {
            options: answer.options,
            type: answer.type,
            ...(multipleAnswers(answer) ? { multiple: true as const } : {}),
            ...(answer.shuffle
              ? { order: shuffledOrder(answer.options.length, answer.locked) }
              : {}),
          };
          break;
        case 'short':
          learner = answer.unit
            ? { type: 'short', unit: answer.unit }
            : { type: 'short' };
          break;
        case 'matching':
          learner = {
            left: answer.pairs.map((pair) => pair.left),
            options: shuffled(answer.options),
            type: 'matching',
          };
          break;
        case 'ordering':
          learner = { items: shuffled(answer.items), type: 'ordering' };
          break;
        case 'gaps':
          learner = { gaps: answer.accepted.length, type: 'gaps' };
          break;
        case 'boolean':
        case 'open':
          learner = { type: answer.type };
          break;
        case 'canvas':
          learner = answer.shared
            ? { shared: true, type: 'canvas' }
            : { type: 'canvas' };
          break;
      }
      return {
        answer: learner,
        blocks: part.blocks,
        id: part.id,
        marks: part.marks,
        ...(part.group ? { group: part.group } : {}),
      };
    }),
  };
}

/** Stands in for the grading model: an item earns its marks when the answer shares a long
 * word with it; a blank answer earns 0 on every item. */
function mockGrader(part: QuestionPart, answer: Answer | undefined): number[] {
  const text = typeof answer === 'string' ? answer.toLowerCase().trim() : '';
  return (part.markscheme ?? []).map((item) =>
    text &&
    item.text
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.length > 3 && text.includes(word))
      ? item.marks
      : 0
  );
}

/** Stands in for the vision model: a drawing earns every item but the last,
 * so a result shows a part partly right; no drawing earns nothing. */
function mockDrawing(part: QuestionPart, answer: Answer | undefined) {
  const scheme = part.markscheme ?? [];
  return scheme.map((item, i) =>
    isDrawingValue(answer ?? null) && i < scheme.length - 1 ? item.marks : 0
  );
}

/** Mirrors the server's grading: each part's `awarded`, an open part's
 * `itemAwards` and a matching or gaps part's `itemResults`, on the full
 * questions, which carry the key back. */
export function gradeQuestions(
  questions: Question[],
  answers: Answers
): { questions: Question[]; awarded: number; max: number } {
  const graded = questions.map((question) => ({
    ...question,
    parts: question.parts.map((part): QuestionPart => {
      if (part.answer.type === 'open')
        return applyItemAwards(part, mockGrader(part, answers[part.id]));
      // A part answered in the canvas above is marked on its drawing.
      if (part.answer.type === 'canvas')
        return applyItemAwards(
          part,
          mockDrawing(part, partAnswer(question, answers, part))
        );
      const { awarded, items } = scorePart(part, answers[part.id]);
      return part.answer.type === 'matching' || part.answer.type === 'gaps'
        ? { ...part, awarded, itemResults: items }
        : { ...part, awarded };
    }),
  }));
  const parts = graded.flatMap((question) => question.parts);
  return {
    awarded: parts.reduce((sum, part) => sum + (part.awarded ?? 0), 0),
    max: parts.reduce((sum, part) => sum + part.marks, 0),
    questions: graded,
  };
}
