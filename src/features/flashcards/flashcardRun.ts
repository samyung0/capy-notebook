import { useEffect, useState } from 'react';
import type { FlashcardContent } from '@/features/materials/blocks';
import { PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';
import type { FlashcardRun } from './StudyBody';

/** A run as this browser keeps it: the attempt and each card's ratings in the
 * order first rated. Faces come from the set when it resumes, so a card
 * deleted since leaves the run. */
type StoredRun = {
  id: string;
  startedAt: string;
  takenAt: string;
  ratings: [cardId: string, ratings: number[]][];
};

const isRatings = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((n) => Number.isInteger(n) && n >= 1 && n <= 4);

const isStoredRun = (value: unknown): value is StoredRun =>
  !!value &&
  typeof value === 'object' &&
  'id' in value &&
  typeof value.id === 'string' &&
  'startedAt' in value &&
  typeof value.startedAt === 'string' &&
  'takenAt' in value &&
  typeof value.takenAt === 'string' &&
  'ratings' in value &&
  Array.isArray(value.ratings) &&
  value.ratings.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      isRatings(entry[1])
  );

/**
 * The set's run kept in this browser for `owner` (the signed-in user's id on
 * the app page, `share` on share pages), so a reload or a later visit
 * continues it until Reset or Study again. The server keeps a workspace set's
 * attempt under the same id. `afterHydration` reads it once the page is live, for
 * server-rendered share pages, whose first render must match the server's.
 */
export function useKeptFlashcardRun(
  owner: string,
  setId: string,
  cards: FlashcardContent[],
  { afterHydration = false } = {}
) {
  const key = PREF_KEYS.flashcardRun(owner, setId);
  const read = () => readPref<StoredRun | null>(key, null, isStoredRun);
  const [kept, setKept] = useState(() => ({
    key,
    stored: afterHydration ? null : read(),
  }));
  let { stored } = kept;
  // Another owner or set (the user read after the page opened) reads again.
  if (kept.key !== key && !afterHydration) {
    stored = read();
    setKept({ key, stored });
  }
  const [ready, setReady] = useState(!afterHydration);
  useEffect(() => {
    if (!afterHydration) return;
    setKept({ key, stored: read() });
    setReady(true);
  }, []);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const resume: FlashcardRun | undefined = stored
    ? {
        cards: stored.ratings.flatMap(([id, ratings]) => {
          const card = byId.get(id);
          return card
            ? [
                {
                  back: card.back,
                  front: card.front,
                  id,
                  image: card.image,
                  ratings,
                },
              ]
            : [];
        }),
        id: stored.id,
        startedAt: stored.startedAt,
        takenAt: stored.takenAt,
      }
    : undefined;
  return {
    forget: () => writePref(key, null),
    keep: (run: FlashcardRun) =>
      writePref(key, {
        id: run.id,
        ratings: run.cards.map((card) => [card.id, card.ratings]),
        startedAt: run.startedAt,
        takenAt: run.takenAt,
      } satisfies StoredRun),
    /** False until a share page has read the kept run. */
    ready,
    resume,
  };
}
