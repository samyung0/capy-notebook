import { api } from '@/api/client';
import type { OpenGradeInput, OpenGradeResult } from './judge';
import { parseGradeResponse } from './judge';

export type GradeQuizAnswerResp = {
  award: number;
  reason: string;
};

export async function gradeOpenViaCloud(
  input: OpenGradeInput,
  workspaceId?: string
): Promise<OpenGradeResult> {
  const body = await api.post<GradeQuizAnswerResp>('/quiz-grade', {
    hints: input.hints,
    modelAnswer: input.modelAnswer,
    prompt: input.prompt,
    rubrics: input.rubrics,
    userAnswer: input.userAnswer,
    workspaceId,
  });
  return parseGradeResponse(
    JSON.stringify({ reason: body.reason, score: body.award })
  );
}
