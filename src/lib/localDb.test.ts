import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  anonymousId,
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
