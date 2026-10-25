import { checkSharedNoteQuiz, gradeAnonymousNoteQuiz } from '@/api/anonymous';
import type { GradeAnonymousQuizReq } from '@/api/types';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { useMemoryRun } from '@/features/quizzes/quizRun';
import { anonymousId } from '@/lib/localDb';
import type { PublicEmbedProps } from './publicEmbeds';
import { sessionNow } from './session';
import { useTurnstileCheck } from './TurnstileCheck';

/** Grades one question of a quiz embedded in a shared note, recording
 * nothing: a signed-in visitor's under their daily grading parts with no
 * captcha, any other (signed out, failed or not yet settled) with a
 * Turnstile token from under its Check (`takeToken`, Q311, Q372). */
export async function gradeEmbeddedQuiz(
  token: string,
  quizId: string,
  questionId: string,
  answers: GradeAnonymousQuizReq['answers'],
  takeToken: () => Promise<string>
) {
  if (sessionNow() === true) {
    return checkSharedNoteQuiz(token, quizId, { answers, questionId });
  }
  return gradeAnonymousNoteQuiz(token, quizId, {
    answers,
    localId: await anonymousId().catch(() => undefined),
    questionId,
    turnstileToken: await takeToken(),
  });
}

/** A quiz embedded in a shared note, graded through the note's link. */
export function PublicQuizEmbed({ embed, token }: PublicEmbedProps) {
  const turnstile = useTurnstileCheck();
  const control = useMemoryRun((questionId, answers) =>
    gradeEmbeddedQuiz(token, embed.id, questionId, answers, turnstile.take)
  );
  return (
    <AttemptBody
      belowCheck={turnstile.view}
      control={control}
      embedded
      name=""
      provenance={embed.provenance}
      questions={embed.questions ?? []}
      trail={[]}
    />
  );
}
