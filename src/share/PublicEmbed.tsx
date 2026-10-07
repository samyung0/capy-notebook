import { createContext, useContext } from 'react';
import { gradeAnonymousNoteQuiz } from '@/api/anonymous';
import type { AnonymousEmbed } from '@/api/types';
import { StudyBody } from '@/features/flashcards/StudyBody';
import {
  type EmbedProps,
  EmbedUnavailable,
} from '@/features/materials/embeds/EmbedView';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { anonymousId } from '@/lib/localDb';

/** The shared note's link and the quizzes and sets it embeds, from the same
 * edge-cached read as the note. */
export const PublicEmbedsContext = createContext<{
  embeds: Map<string, AnonymousEmbed>;
  token: string;
} | null>(null);

/** An embedded quiz or set on the public note page: studied in place like in
 * the app, graded through the note's link, recording nothing. */
export function PublicEmbed({ materialId }: EmbedProps) {
  const shared = useContext(PublicEmbedsContext);
  const embed = shared?.embeds.get(materialId);
  if (!(shared && embed)) return <EmbedUnavailable />;
  if (embed.kind === 'quiz')
    return (
      <AttemptBody
        embedded
        grade={async (answers) =>
          gradeAnonymousNoteQuiz(shared.token, embed.id, {
            answers,
            localId: await anonymousId().catch(() => undefined),
          })
        }
        name=""
        questions={embed.questions ?? []}
        trail={[]}
      />
    );
  return (
    <StudyBody
      cards={embed.cards ?? []}
      embedded
      name=""
      onRate={() => undefined}
      trail={[]}
    />
  );
}
