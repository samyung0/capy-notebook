import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  deleteLocalDrawingDraft,
  localCardStates,
  localDrawingPictures,
  localQuizAttempts,
  recordLocalCardReview,
  saveLocalQuizAttempt,
  syncLocalDrawingPictures,
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
      startedAt: takenAt,
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

  it("keeps a drawing draft's pictures beside it, each written once, until they leave the board or the draft goes", async () => {
    const file = (text: string) => new Blob([text], { type: 'image/webp' });
    await syncLocalDrawingPictures(
      'quiz:q:p',
      [
        { file: file('a'), id: 'a' },
        { file: file('b'), id: 'b' },
      ],
      ['a', 'b']
    );
    await syncLocalDrawingPictures(
      'quiz:q:other',
      [{ file: file('z'), id: 'a' }],
      ['a']
    );
    // A later write adds nothing and names what is still on the board.
    await syncLocalDrawingPictures('quiz:q:p', [], ['b']);
    expect(
      (await localDrawingPictures('quiz:q:p')).map(({ id }) => id)
    ).toEqual(['b']);
    await deleteLocalDrawingDraft('quiz:q:p');
    expect(await localDrawingPictures('quiz:q:p')).toEqual([]);
    expect(await localDrawingPictures('quiz:q:other')).toHaveLength(1);
  });
});
