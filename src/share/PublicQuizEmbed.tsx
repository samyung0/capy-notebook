import { gradeAnonymousNoteQuiz } from '@/api/anonymous';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { anonymousId } from '@/lib/localDb';
import type { PublicEmbedProps } from './publicEmbeds';

/** A quiz embedded in a shared note: graded through the note's link,
 * recording nothing. */
export function PublicQuizEmbed({ embed, token }: PublicEmbedProps) {
  return (
    <AttemptBody
      embedded
      grade={async (answers) =>
        gradeAnonymousNoteQuiz(token, embed.id, {
          answers,
          localId: await anonymousId().catch(() => undefined),
        })
      }
      name=""
      provenance={embed.provenance}
      questions={embed.questions ?? []}
      trail={[]}
    />
  );
}
