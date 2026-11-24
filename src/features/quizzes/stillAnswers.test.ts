import { expect, it } from 'vitest';
import type { Question, QuestionPart } from '@/features/questions/types';
import { drawingMoves, keptAnswers, renamedDrafts } from './stillAnswers';

const canvasPart = (id: string, shared: boolean): QuestionPart => ({
  answer: shared ? { shared: true, type: 'canvas' } : { type: 'canvas' },
  blocks: shared
    ? [{ text: id, type: 'text' }]
    : [{ text: id, type: 'text' }, { type: 'canvas' }],
  id,
  marks: 1,
  markscheme: [{ marks: 1, text: id }],
  solution: [],
});

// a and b as their switches say (true: Same canvas, the stem's), then a
// short-answer part.
const question = (a: boolean, b: boolean): Question => ({
  id: 'q',
  labels: 'letters',
  layout: 'paper',
  parts: [
    canvasPart('a', a),
    canvasPart('b', b),
    {
      answer: { accepted: ['x'], type: 'short' },
      blocks: [{ text: 'c', type: 'text' }],
      id: 'c',
      marks: 1,
      solution: [],
    },
  ],
  stem: [{ text: 'Stem', type: 'text' }, { type: 'canvas' }],
});

const stemDrawing = { drawing: 'dr_stem' };
const ownDrawing = { drawing: 'dr_own' };

// Epo 2026-11-24: a shared canvas's drawing follows its canvas. Go's
// TestRepublishMovesADrawingWithItsCanvas is the same.
it("moves the stem's drawing to its first answering part when the lead switches to New", () => {
  const before = [question(true, true)];
  const after = [question(false, true)];
  expect(Object.fromEntries(drawingMoves(before, after))).toEqual({ a: 'b' });
  expect(keptAnswers(before, after, { a: stemDrawing, c: 'x' })).toEqual({
    b: stemDrawing,
    c: 'x',
  });
});

it('drops a part’s own drawing once no part answers in its canvas', () => {
  const before = [question(true, false)];
  const after = [question(true, true)];
  expect(Object.fromEntries(drawingMoves(before, after))).toEqual({ b: null });
  expect(
    keptAnswers(before, after, { a: stemDrawing, b: ownDrawing, c: 'x' })
  ).toEqual({ a: stemDrawing, c: 'x' });
});

it('gives the new lead the canvas’s drawing in place of the one it held', () => {
  const before = [question(true, false)];
  const after = [question(false, true)];
  expect(keptAnswers(before, after, { a: stemDrawing, b: ownDrawing })).toEqual(
    { b: stemDrawing }
  );
  // Unchanged questions keep the answers as they are.
  const current = { a: stemDrawing, b: ownDrawing };
  expect(keptAnswers(before, [question(true, false)], current)).toBe(current);
});

// Ungroup hands the group's canvas to its first sub-part, as its own (Epo
// 2026-11-24): the drawing stays with it, and its device draft is copied to
// the canvas's new name.
it("keeps a group canvas's drawing with the sub-part Ungroup hands it to", () => {
  const grouped: Question = {
    groups: [
      { blocks: [{ text: 'G', type: 'text' }, { type: 'canvas' }], id: 'g' },
    ],
    id: 'q',
    labels: 'letters',
    layout: 'paper',
    parts: [
      { ...canvasPart('a', true), group: 'g' },
      { ...question(true, true).parts[2], group: 'g' },
    ],
    stem: [],
  };
  const lone: Question = {
    ...grouped,
    groups: undefined,
    parts: [
      {
        ...canvasPart('a', false),
        blocks: [
          { text: 'G', type: 'text' },
          { type: 'canvas' },
          { text: 'a', type: 'text' },
        ],
      },
      question(true, true).parts[2],
    ],
  };
  const current = { a: stemDrawing, c: 'x' };
  expect(keptAnswers([grouped], [lone], current)).toBe(current);
  expect(renamedDrafts([grouped], [lone])).toEqual([['q:group:g', 'q:part:a']]);
});
