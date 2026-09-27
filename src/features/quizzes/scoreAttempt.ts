import type { Question, QuestionBlock, QuestionPart } from '@/api/types';
import { gradeOpenViaCloud } from './cloudGrade';
import {
  type Answers,
  applyOpenAward,
  scorePart,
  scoreQuestion,
  sumScores,
} from './grade';

/** Preserve readable context for the existing text-only quiz grading slot. */
export function blocksToText(blocks: QuestionBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return [block.label, block.text].filter(Boolean).join('\n');
        case 'image':
        case 'graph':
          return '[Figure: ' + block.description + ']';
        case 'table':
          return block.rows.map((row) => row.join(' | ')).join('\n');
        case 'chart':
          return (
            block.title +
            (block.unit ? ' (' + block.unit + ')' : '') +
            '\n' +
            block.series
              .map(
                (series) =>
                  series.name +
                  ': ' +
                  series.values
                    .map((value, i) => block.labels[i] + '=' + value)
                    .join(', ')
              )
              .join('\n')
          );
      }
      throw new Error('Unsupported question block');
    })
    .join('\n\n');
}
export async function gradeAttemptQuestions(
  questions: Question[],
  answers: Answers,
  opts: { workspaceId?: string }
): Promise<{ questions: Question[]; awarded: number; max: number }> {
  const next: Question[] = [];
  for (const question of questions) {
    const parts: QuestionPart[] = [];
    for (const part of question.parts) {
      if (part.answer.type !== 'open') {
        parts.push({
          ...part,
          awarded: scorePart(part, answers[part.id]).awarded,
        });
        continue;
      }
      const answer = answers[part.id];
      const userAnswer = typeof answer === 'string' ? answer : '';
      if (!userAnswer.trim()) {
        parts.push(applyOpenAward(part, 0));
        continue;
      }
      const result = await gradeOpenViaCloud(
        {
          hints: part.answer.hints,
          modelAnswer: part.answer.accepted.join('\n'),
          prompt: [
            blocksToText(question.stem),
            ...question.parts
              .slice(0, parts.length)
              .map(
                (prior, i) =>
                  'Earlier part ' + (i + 1) + ': ' + blocksToText(prior.blocks)
              ),
            'Part to grade: ' + blocksToText(part.blocks),
          ]
            .filter(Boolean)
            .join('\n\n'),
          rubrics: part.markscheme,
          userAnswer,
        },
        opts.workspaceId
      );
      parts.push(applyOpenAward(part, result.award, result.reason));
    }
    next.push({ ...question, parts });
  }
  return {
    ...sumScores(next.map((q) => scoreQuestion(q, answers))),
    questions: next,
  };
}
