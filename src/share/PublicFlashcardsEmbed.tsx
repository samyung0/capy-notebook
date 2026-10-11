import { StudyBody } from '@/features/flashcards/StudyBody';
import type { PublicEmbedProps } from './publicEmbeds';

/** A flashcard set embedded in a shared note: studied in place, recording
 * nothing. */
export function PublicFlashcardsEmbed({ embed }: PublicEmbedProps) {
  return (
    <StudyBody
      cards={embed.cards ?? []}
      embedded
      name=""
      onRate={() => undefined}
      provenance={embed.provenance}
      trail={[]}
    />
  );
}
