import { checkSharedNoteQuiz, gradeAnonymousNoteQuiz } from '@/api/anonymous';
import type { GradeAnonymousQuizReq } from '@/api/types';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { anonymousId } from '@/lib/localDb';
import type { PublicEmbedProps } from './publicEmbeds';
import { sessionNow } from './session';
import { takeTurnstileToken } from './turnstile';

/** Grades a check of a quiz embedded in a shared note, recording nothing: a
 * signed-in visitor's under their daily grading parts with no captcha, any
 * other (signed out, or the session not yet settled) with a Turnstile token
 * (Q311). */
export async function gradeEmbeddedQuiz(
  token: string,
  quizId: string,
  answers: GradeAnonymousQuizReq['answers']
) {
  if (sessionNow() === true) return checkSharedNoteQuiz(token, quizId, answers);
  return gradeAnonymousNoteQuiz(token, quizId, {
    answers,
    localId: await anonymousId().catch(() => undefined),
    turnstileToken: await takeTurnstileToken(),
  });
}

/** A quiz embedded in a shared note, graded through the note's link. */
export function PublicQuizEmbed({ embed, token }: PublicEmbedProps) {
  return (
    <AttemptBody
      embedded
      grade={(answers) => gradeEmbeddedQuiz(token, embed.id, answers)}
      name=""
      provenance={embed.provenance}
      questions={embed.questions ?? []}
      trail={[]}
    />
  );
}
