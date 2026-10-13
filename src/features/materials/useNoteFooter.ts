import { type QueryKey, skipToken, useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { qk } from '@/api/client';
import type { Material, Provenance } from '@/api/types';
import {
  MATERIAL_REF_TYPE,
  type MaterialRefKind,
} from '@/features/materials/document';
import { noteFooterProvenance } from './footerUnion';

/** The query an embedded material's block reads it under (AppEmbed), for
 * each item kind of the embed catalog (liveCatalog.test.ts). */
export const EMBED_READ_KEYS: Record<
  MaterialRefKind,
  (id: string) => QueryKey
> = {
  flashcards: qk.material,
  quiz: qk.quiz,
};

/** The quizzes and flashcard sets a note's blocks embed, in document order, as
 * one string ("kind:id kind:id"): equal strings mean the same embeds, so a
 * caller can keep one across edits that change nothing of them. A reference
 * of a kind this version has no read for (a newer version wrote it; the
 * note's room is then read-only) has no credits here. */
export function embedKey(
  value: readonly { type?: unknown; materialId?: unknown; refKind?: unknown }[]
) {
  return value
    .flatMap((node) =>
      node.type === MATERIAL_REF_TYPE &&
      typeof node.materialId === 'string' &&
      typeof node.refKind === 'string' &&
      Object.hasOwn(EMBED_READ_KEYS, node.refKind)
        ? [`${node.refKind}:${node.materialId}`]
        : []
    )
    .join(' ');
}

/**
 * A note's footer credits now (Epo 2026-10-11): its own record plus each
 * embed in `key` (embedKey), from the embed's own read where its block made
 * one, else the note read's `embedCredits`, the server's value at load. An
 * embed whose read failed (trashed, gone) drops out. It recomputes only when
 * the embeds or one of their reads change, and fetches nothing itself.
 */
export function useNoteFooter(
  material: Pick<Material, 'embedCredits' | 'provenance'>,
  key: string
): Provenance | undefined {
  const refs = useMemo(
    () =>
      key
        ? key.split(' ').map((entry) => {
            const at = entry.indexOf(':');
            return {
              id: entry.slice(at + 1),
              kind: entry.slice(0, at) as MaterialRefKind,
            };
          })
        : [],
    [key]
  );
  const reads = useQueries({
    combine: (results) => results,
    queries: refs.map((ref) => ({
      queryFn: skipToken,
      queryKey: EMBED_READ_KEYS[ref.kind](ref.id),
      select: (data: { provenance?: Provenance }) => data.provenance,
    })),
  });
  const { embedCredits, provenance } = material;
  return useMemo(() => {
    const embeds: Provenance[] = [];
    refs.forEach((ref, i) => {
      const read = reads[i];
      if (read?.isError) return;
      const credits = read?.isSuccess ? read.data : embedCredits?.[ref.id];
      if (credits) embeds.push(credits);
    });
    return noteFooterProvenance(provenance, embeds);
  }, [refs, reads, embedCredits, provenance]);
}
