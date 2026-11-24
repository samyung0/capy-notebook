import { beforeEach, expect, it, vi } from 'vitest';
import { withAnswer } from './questionEdits';
import {
  forgetCanvas,
  forgetGoneParts,
  forgetPart,
  giveMemory,
  heldSample,
  holdSample,
  keepAnswer,
  keepCanvas,
  keepPart,
  keptAnswer,
  keptCanvas,
  keptPart,
} from './typeMemory';
import type { QuestionPart } from './types';

let session: Map<string, string>;
beforeEach(() => {
  session = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    removeItem: (key: string) => session.delete(key),
    setItem: (key: string, value: string) => session.set(key, value),
  });
});

const choice: QuestionPart = {
  answer: { correct: [1], options: ['Osmosis', 'Diffusion'], type: 'mcq' },
  blocks: [{ text: 'Which moves water?', type: 'text' }],
  id: 'p1',
  marks: 1,
  solution: [],
};

// Epo 2026-11-23: multiple choice to blanks and back keeps its options.
it("keeps a part's answer and marking scheme for its type, by quiz and part", () => {
  keepAnswer('qz_1', choice);
  expect(keptAnswer('qz_1', 'p1', 'mcq')).toEqual({ answer: choice.answer });
  const open: QuestionPart = {
    ...choice,
    answer: { accepted: [], type: 'open' },
    markscheme: [{ marks: 2, text: 'Names osmosis.' }],
  };
  keepAnswer('qz_1', open);
  expect(keptAnswer('qz_1', 'p1', 'open')).toEqual({
    answer: open.answer,
    markscheme: open.markscheme,
  });
  expect(keptAnswer('qz_1', 'p1', 'gaps')).toBeNull();
  expect(keptAnswer('qz_2', 'p1', 'mcq')).toBeNull();
});

// Epo 2026-11-23: blanks to multiple choice and back keeps each blank's
// list, its text's blanks still numbered to match them.
it("gives a blanks part's lists back to its blanks after a switch away", () => {
  const blanks: QuestionPart = {
    answer: { accepted: [['Paris'], ['Seine', 'la Seine']], type: 'gaps' },
    blocks: [{ text: '(1) ______ stands on the (2) ______.', type: 'text' }],
    id: 'p1',
    marks: 2,
    solution: [],
  };
  // As the card switches it: kept, turned, then turned back with what was kept.
  keepAnswer('qz_1', blanks);
  const choice = withAnswer(blanks, {
    correct: [],
    options: ['Option 1', 'Option 2'],
    type: 'mcq',
  });
  const kept = keptAnswer('qz_1', 'p1', 'gaps');
  if (!kept) throw new Error('nothing kept');
  const back = withAnswer(choice, kept.answer);
  expect(back.answer).toEqual(blanks.answer);
  expect(back.blocks).toEqual(blanks.blocks);
});

// Epo 2026-11-23: Same canvas keeps the part's own canvas until New's write
// lands.
it('keeps a canvas by part until it is forgotten', () => {
  const canvas = { block: { type: 'canvas' as const }, index: 1 };
  keepCanvas('qz_1', 'p1', canvas);
  expect(keptCanvas('qz_2', 'p1')).toBeNull();
  expect(keptCanvas('qz_1', 'p1')).toEqual(canvas);
  forgetCanvas('qz_1', 'p1');
  expect(keptCanvas('qz_1', 'p1')).toBeNull();
});

// Epo 2026-11-24: what Add part kept goes back only into a part it made, and
// goes when Undo leaves none of them.
it('gives a split part back for a part it made, and forgets it once they are gone', () => {
  const held = {
    answer: choice.answer,
    from: 'p1',
    marks: 1,
    parts: ['x', 'y'],
    solution: [],
  };
  keepPart('qz_1', 'q1', held);
  expect(keptPart('qz_1', 'q1', 'p1')).toBeNull();
  expect(keptPart('qz_1', 'q1', 'y')).toMatchObject(held);
  forgetPart('qz_1', 'q1', 'y');
  expect(keptPart('qz_1', 'q1', 'x')).toBeNull();
  keepPart('qz_1', 'q1', held);
  forgetGoneParts('qz_1', 'q1', ['x', 'z']);
  expect(keptPart('qz_1', 'q1', 'x')).toMatchObject(held);
  // Undo: the lone part is back, its own id again.
  forgetGoneParts('qz_1', 'q1', ['p1']);
  expect(keptPart('qz_1', 'q1', 'x')).toBeNull();
});

// Epo 2026-11-24: Add part blanks a part into new ids; its own memory (the
// canvas Same took, a held sample, its answers by type) goes with what was
// kept, back under the part it is restored into, and Add sub-part on both
// blanks keeps it while Undo of those can still restore it.
it("carries a blanked part's own memory to the part it goes back into", () => {
  const canvas = {
    block: { board: 'b', image: 'i', type: 'canvas' as const },
    index: 1,
  };
  const sample = { board: 's', image: 't' };
  keepCanvas('qz_1', 'p1', canvas);
  holdSample('qz_1', 'p1', sample);
  keepAnswer('qz_1', choice);
  keepPart('qz_1', 'q1', {
    answer: { shared: true, type: 'canvas' },
    from: 'p1',
    marks: 1,
    parts: ['x', 'y'],
    solution: [],
  });
  // Add sub-part on (a) and on (b).
  for (const [from, parts] of [
    ['x', ['x1', 'x2']],
    ['y', ['y1', 'y2']],
  ] as const)
    keepPart('qz_1', 'q1', {
      answer: choice.answer,
      from,
      marks: 1,
      parts: [...parts],
      solution: [],
    });
  forgetGoneParts('qz_1', 'q1', ['x1', 'x2', 'y1', 'y2']);
  const kept = keptPart('qz_1', 'q1', 'x');
  if (!kept?.own) throw new Error('nothing kept');
  giveMemory('qz_1', 'x', kept.own);
  expect(keptCanvas('qz_1', 'x')).toEqual(canvas);
  expect(heldSample('qz_1', 'x')).toEqual(sample);
  expect(keptAnswer('qz_1', 'x', 'mcq')).toEqual({ answer: choice.answer });
});

it('forgets quietly where the tab keeps nothing', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  keepAnswer('qz_1', choice);
  expect(keptAnswer('qz_1', 'p1', 'mcq')).toBeNull();
});
