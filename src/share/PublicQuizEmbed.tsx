import { gradeAnonymousNoteQuiz } from '@/api/anonymous';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { anonymousId } from '@/lib/localDb';
import type { PublicEmbedProps } from './publicEmbeds';
import { useTurnstile } from './turnstile';

/** A quiz embedded in a shared note: graded through the note's link,
 * recording nothing, with a Turnstile token on every check. */
export function PublicQuizEmbed({ embed, token }: PublicEmbedProps) {
  const turnstile = useTurnstile(true);
  return (
    <>
      <AttemptBody
        embedded
        grade={async (answers) =>
          gradeAnonymousNoteQuiz(token, embed.id, {
            answers,
            localId: await anonymousId().catch(() => undefined),
            turnstileToken: await turnstile.take(),
          })
        }
        name=""
        provenance={embed.provenance}
        questions={embed.questions ?? []}
        trail={[]}
      />
      <div ref={turnstile.box} />
    </>
  );
}
