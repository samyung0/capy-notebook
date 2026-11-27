import { hashKey, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
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
 *
 * It reads the cache without observers (Q904): an observer copies its
 * options onto the shared query, so a footer observer without a query
 * function stripped the embed block's own (and its `errorBoundary: false`),
 * and a broken embed's retry then failed the whole note.
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
  const queryClient = useQueryClient();
  const hashes = useMemo(
    () => refs.map((ref) => hashKey(EMBED_READ_KEYS[ref.kind](ref.id))),
    [refs]
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      const watched = new Set(hashes);
      return queryClient
        .getQueryCache()
        .subscribe((event) => watched.has(event.query.queryHash) && onChange());
    },
    [queryClient, hashes]
  );
  // A value, so an unrelated cache event re-renders nothing. The same on the
  // server: the site Worker renders shared notes.
  const snapshot = () =>
    hashes
      .map((hash) => {
        const state = queryClient.getQueryCache().get(hash)?.state;
        return state ? `${state.status}:${state.dataUpdatedAt}` : '';
      })
      .join(' ');
  const reads = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { embedCredits, provenance } = material;
  // `reads` stands for the cached states read below.
  return useMemo(() => {
    const cache = queryClient.getQueryCache();
    const embeds: Provenance[] = [];
    refs.forEach((ref, i) => {
      const state = cache.get<{ provenance?: Provenance }>(hashes[i])?.state;
      if (state?.status === 'error') return;
      const credits =
        state?.status === 'success'
          ? state.data?.provenance
          : embedCredits?.[ref.id];
      if (credits) embeds.push(credits);
    });
    return noteFooterProvenance(provenance, embeds);
  }, [queryClient, refs, hashes, reads, embedCredits, provenance]);
}
