import {
  type EmbedProps,
  EmbedUnavailable,
} from '@/features/materials/embeds/EmbedView';
import { PublicFlashcardsEmbed } from './PublicFlashcardsEmbed';
import { PublicQuizEmbed } from './PublicQuizEmbed';
import { usePublicEmbed } from './publicEmbeds';

/** An embedded quiz or set on the public note page as the Worker renders it
 * (SharedNote.tsx); the browser hydrates it with each kind's code loaded on
 * its own (islands.tsx). */
export function PublicEmbed({ materialId }: EmbedProps) {
  const found = usePublicEmbed(materialId);
  if (!found) return <EmbedUnavailable />;
  return found.embed.kind === 'quiz' ? (
    <PublicQuizEmbed {...found} />
  ) : (
    <PublicFlashcardsEmbed {...found} />
  );
}
