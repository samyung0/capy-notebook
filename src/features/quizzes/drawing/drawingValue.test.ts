import { expect, it, vi } from 'vitest';

const deleteLocalDrawingDraft = vi.hoisted(() =>
  vi.fn(() => Promise.resolve())
);
vi.mock('@/lib/localDb', () => ({ deleteLocalDrawingDraft }));

const { forgetDrawingDrafts, quizDraftScope } = await import('./drawingValue');

it('forgets the drafts of the drawings a check sent, and only those', () => {
  forgetDrawingDrafts(quizDraftScope('qz_1'), {
    'q1:a': { board: 'AA==', image: 'data:image/webp;base64,AA==' },
    'q1:b': 'an open answer',
  });
  expect(deleteLocalDrawingDraft.mock.calls).toEqual([['quiz:qz_1:q1:a']]);
});
