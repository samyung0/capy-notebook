import { expect, it } from 'vitest';
import { type Question, questionAssetIds, replaceAssetIds } from './types';

const drawn: Question = {
  id: 'q1',
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: {
        sample: { board: 'a_board', image: 'a_image' },
        type: 'drawing',
      },
      blocks: [{ text: 'Draw it.', type: 'text' }],
      id: 'p1',
      marks: 1,
      markscheme: [{ marks: 1, text: 'Shape' }],
      solution: [],
    },
  ],
  stem: [],
};

// A drawn sample answer's board and image are the quiz's assets (Q3): listed
// with its images and swapped with them on a copy.
it("lists and swaps a drawn sample answer's assets", () => {
  expect(questionAssetIds(drawn)).toEqual(['a_board', 'a_image']);
  const copied = replaceAssetIds(
    drawn,
    new Map([
      ['a_board', 'b_board'],
      ['a_image', 'b_image'],
    ])
  );
  expect(questionAssetIds(copied)).toEqual(['b_board', 'b_image']);
});
