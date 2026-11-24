import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  copyLocalDrawingDrafts,
  deleteLocalDrawingDraft,
  localCardStates,
  localDrawingDraft,
  localDrawingPictures,
  localQuizAttempts,
  recordLocalCardReview,
  saveLocalDrawingDraft,
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

  // Epo 2026-11-24: drafts are kept by canvas, and one an edit renamed (an
  // Ungroup's) is copied to its new name, the old one staying.
  it('copies a drawing draft with its pictures to another key', async () => {
    const file = new Blob(['x'], { type: 'image/webp' });
    await saveLocalDrawingDraft({
      doc: 'G',
      key: 'quiz:m:q:group:g',
      savedAt: '2026-11-24',
    });
    await syncLocalDrawingPictures(
      'quiz:m:q:group:g',
      [{ file, id: 'G' }],
      ['G']
    );
    await copyLocalDrawingDrafts([['quiz:m:q:group:g', 'quiz:m:q:part:a']]);
    expect((await localDrawingDraft('quiz:m:q:part:a'))?.doc).toBe('G');
    expect(
      (await localDrawingPictures('quiz:m:q:part:a')).map(({ id }) => id)
    ).toEqual(['G']);
    expect(await localDrawingDraft('quiz:m:q:group:g')).toBeDefined();
  });
});
