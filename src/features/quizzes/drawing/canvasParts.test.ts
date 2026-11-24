import { expect, it, vi } from 'vitest';
import type { Question, QuestionPart } from '@/features/questions/types';
import {
  drawingParts,
  forgetDrawingDrafts,
  partAnswer,
  sharingParts,
} from './canvasParts';

const deleteLocalDrawingDraft = vi.hoisted(() =>
  vi.fn(() => Promise.resolve())
);
vi.mock('@/lib/localDb', () => ({ deleteLocalDrawingDraft }));

const part = (
  id: string,
  answer: QuestionPart['answer'],
  extra: Partial<QuestionPart> = {}
): QuestionPart => ({
  answer,
  blocks: [{ text: id, type: 'text' }],
  id,
  marks: 1,
  markscheme: [{ marks: 1, text: id }],
  solution: [],
  ...extra,
});

// Epo 2026-11-23: the parts answering in one canvas share one drawing, kept
// under the first of them; a part on its own canvas keeps its own. Go's
// questions.DrawingParts is the same (TestDrawingParts).
it('keeps one drawing per canvas, under the first part answering in it', () => {
  const question: Question = {
    groups: [{ blocks: [{ type: 'canvas' }], id: 'g' }],
    id: 'q',
    labels: 'letters',
    layout: 'paper',
    parts: [
      part('a', { shared: true, type: 'canvas' }),
      part('b', { shared: true, type: 'canvas' }),
      part(
        'c',
        { type: 'canvas' },
        { blocks: [{ type: 'canvas' }], group: 'g' }
      ),
      part('d', { shared: true, type: 'canvas' }, { group: 'g' }),
      part('e', { shared: true, type: 'canvas' }, { group: 'g' }),
      part('f', { accepted: ['x'], type: 'short' }),
    ],
    stem: [{ text: 'Stem', type: 'text' }, { type: 'canvas' }],
  };
  expect(Object.fromEntries(drawingParts(question))).toEqual({
    a: 'a',
    b: 'a',
    c: 'c',
    d: 'd',
    e: 'd',
  });
  expect(sharingParts(question, {}, 1).map(({ id }) => id)).toEqual(['a', 'b']);
  expect(
    sharingParts(question, { groupId: 'g' }, 0).map(({ id }) => id)
  ).toEqual(['d', 'e']);
  const drawing = { drawing: 'dr_1' };
  expect(partAnswer(question, { a: drawing }, question.parts[1])).toBe(drawing);
});

// A check forgets the device drafts of the canvases whose drawings it sent,
// each by its canvas (Epo 2026-11-24), and only those.
it('forgets the drafts of the canvases a check sent drawings for', () => {
  const question: Question = {
    id: 'q1',
    labels: 'letters',
    layout: 'paper',
    parts: [
      part('a', { shared: true, type: 'canvas' }),
      part('b', { shared: true, type: 'canvas' }),
      part('c', { type: 'canvas' }, { blocks: [{ type: 'canvas' }] }),
      part('d', { accepted: ['x'], type: 'short' }),
    ],
    stem: [{ type: 'canvas' }],
  };
  forgetDrawingDrafts('quiz:qz_1', question, {
    a: { board: 'AA==', image: 'data:image/webp;base64,AA==' },
    d: 'x',
  });
  expect(deleteLocalDrawingDraft.mock.calls).toEqual([['quiz:qz_1:q1:stem']]);
});
