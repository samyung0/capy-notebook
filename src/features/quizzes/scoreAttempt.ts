import type { ModelRef, Question } from '@/api/types';
import { browserLlmHost } from './browserLlm';
import { isBrowserQuizModel } from './browserModels';
import { gradeOpenViaCloud } from './cloudGrade';
import {
  type Answer,
  applyOpenAward,
  isOpenQuestion,
  scoreQuestion,
  sumScores,
} from './grade';
import { gradeOpenAnswer } from './judge';

export async function gradeAttemptQuestions(
  questions: Question[],
  answers: Record<string, Answer>,
  opts: { model: ModelRef; workspaceId?: string }
): Promise<{ questions: Question[]; awarded: number; max: number }> {
  const next: Question[] = [];
  for (const question of questions) {
    if (!isOpenQuestion(question)) {
      const score = scoreQuestion(question, answers[question.id]);
      next.push({ ...question, awarded: score.awarded });
      continue;
    }
    const userAnswer =
      typeof answers[question.id] === 'string'
        ? (answers[question.id] as string)
        : '';
    if (!userAnswer.trim()) {
      next.push(applyOpenAward(question, 0));
      continue;
    }
    const input = {
      hints: question.hints.map((h) => h.value),
      modelAnswer: question.accepted.map((a) => a.value).join('\n'),
      prompt: question.prompt,
      rubrics: question.rubrics.map((r) => r.value),
      userAnswer,
    };
    const browserModel =
      opts.model.providerSlug === 'browser'
        ? `browser:${opts.model.modelSlug}`
        : '';
    // Browser models stay in the tab. They never hit /quiz-grade or usage_events.
    const result = isBrowserQuizModel(browserModel)
      ? await gradeOpenAnswer(input, (prompt) =>
          browserLlmHost().complete(browserModel, prompt)
        )
      : await gradeOpenViaCloud(input, opts.workspaceId);
    next.push(applyOpenAward(question, result.award, result.reason));
  }
  const total = sumScores(next.map((q) => scoreQuestion(q, answers[q.id])));
  return { awarded: total.awarded, max: total.max, questions: next };
}
