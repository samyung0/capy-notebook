import { createContext, useContext } from 'react';
import type { AnonymousEmbed } from '@/api/types';

/** The shared note's link and the quizzes and sets it embeds, from the same
 * edge-cached read as the note. */
export const PublicEmbedsContext = createContext<{
  embeds: Map<string, AnonymousEmbed>;
  token: string;
} | null>(null);

export type PublicEmbedProps = { embed: AnonymousEmbed; token: string };

/** The embed a note shows at `materialId`, unless the read left it out. */
export function usePublicEmbed(
  materialId: string
): PublicEmbedProps | undefined {
  const shared = useContext(PublicEmbedsContext);
  const embed = shared?.embeds.get(materialId);
  return shared && embed ? { embed, token: shared.token } : undefined;
}
