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
        type: 'canvas',
      },
      blocks: [
        { text: 'Draw it.', type: 'text' },
        { board: 'c_board', image: 'c_image', type: 'canvas' },
      ],
      id: 'p1',
      marks: 1,
      markscheme: [{ marks: 1, text: 'Shape' }],
      solution: [],
    },
  ],
  stem: [],
};

// A drawn canvas's and a drawn sample answer's board and image are the
// quiz's assets (Q3, Epo 2026-11-23): listed with its images and swapped with
// them on a copy.
it("lists and swaps a drawn canvas's and sample answer's assets", () => {
  expect(questionAssetIds(drawn)).toEqual([
    'c_board',
    'c_image',
    'a_board',
    'a_image',
  ]);
  const copied = replaceAssetIds(
    drawn,
    new Map([
      ['c_board', 'd_board'],
      ['c_image', 'd_image'],
      ['a_board', 'b_board'],
      ['a_image', 'b_image'],
    ])
  );
  expect(questionAssetIds(copied)).toEqual([
    'd_board',
    'd_image',
    'b_board',
    'b_image',
  ]);
});
