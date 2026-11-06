import { gradeAnonymousNoteQuiz } from '@/api/anonymous';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { useMemoryRun } from '@/features/quizzes/quizRun';
import type { PublicEmbedProps } from './publicEmbeds';

/** A quiz embedded in a shared note, checked through the note's link, the same
 * for every visitor and recording nothing. */
export function PublicQuizEmbed({ embed, token }: PublicEmbedProps) {
  const control = useMemoryRun((questionId, answers) =>
    gradeAnonymousNoteQuiz(token, embed.id, { answers, questionId })
  );
  return (
    <AttemptBody
      control={control}
      embedded
      name=""
      neverMarks
      provenance={embed.provenance}
      questions={embed.questions ?? []}
      trail={[]}
    />
  );
}
