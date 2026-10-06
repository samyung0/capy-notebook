import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  anonymousId,
  dropKeptAssets,
  KEPT_ASSET_BYTES,
  type KeptAsset,
  keepAsset,
  keptAsset,
  localCardStates,
  localQuizAttempts,
  recordLocalCardReview,
  saveLocalQuizAttempt,
} from './localDb';
import { newSrsState, reviewSrs } from './srs';

describe('browser-local study data', () => {
  it('keeps attempts per quiz, newest first', async () => {
    const attempt = (id: string, quizId: string, takenAt: string) => ({
      answers: {},
      correct: 1,
      id,
      questions: [],
      quizId,
      quizName: 'Quiz',
      takenAt,
      total: 2,
    });
    await saveLocalQuizAttempt(attempt('a1', 'mat_q', '2026-10-01T00:00:00Z'));
    await saveLocalQuizAttempt(attempt('a2', 'mat_q', '2026-10-02T00:00:00Z'));
    await saveLocalQuizAttempt(
      attempt('a3', 'mat_other', '2026-10-02T00:00:00Z')
    );
    expect((await localQuizAttempts('mat_q')).map((a) => a.id)).toEqual([
      'a2',
      'a1',
    ]);
  });

  it('stores the card state derived from each logged review', async () => {
    const srs = reviewSrs(newSrsState(), 'good');
    await recordLocalCardReview(
      {
        cardId: 'c1',
        rating: 'good',
        reviewedAt: srs.last_review ?? '',
        setId: 'mat_s',
      },
      srs
    );
    expect(await localCardStates('mat_s')).toEqual([
      { cardId: 'c1', setId: 'mat_s', srs },
    ]);
  });

  it('creates one stable anonymous id', async () => {
    const id = await anonymousId();
    expect(await anonymousId()).toBe(id);
  });
});

describe('kept editor assets', () => {
  // Stand-ins: the store only reads `size`, so no real bytes are needed.
  const row = (
    session: string,
    assetId: string,
    savedAt: number,
    size: number
  ) =>
    ({
      assetId,
      blob: { size, type: 'image/png' } as unknown as Blob,
      name: `${assetId}.png`,
      purpose: 'image',
      savedAt,
      session,
    }) satisfies KeptAsset;
  const third = Math.floor(KEPT_ASSET_BYTES / 3) + 1;

  it('drops the oldest rows past the cap and skips one over it', async () => {
    await keepAsset(row('s1', 'old', 1, third));
    await keepAsset(row('s1', 'mid', 2, third));
    await keepAsset(row('s2', 'new', 3, third));
    await keepAsset(row('s2', 'huge', 4, KEPT_ASSET_BYTES + 1));
    expect(await keptAsset('s1', 'old')).toBeUndefined();
    expect((await keptAsset('s1', 'mid'))?.name).toBe('mid.png');
    expect(await keptAsset('s2', 'new')).toBeDefined();
    expect(await keptAsset('s2', 'huge')).toBeUndefined();
  });

  it('deletes the rows of sessions no longer alive', async () => {
    await keepAsset(row('live', 'a', 10, 1));
    await keepAsset(row('dead', 'b', 11, 1));
    await dropKeptAssets((session) => session === 'live');
    expect(await keptAsset('live', 'a')).toBeDefined();
    expect(await keptAsset('dead', 'b')).toBeUndefined();
  });
});
