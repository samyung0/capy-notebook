import { expect, it } from 'vitest';
import { QUESTION_GRAPH_ELEMENTS_MAX } from '@/api/limits.generated';
import { drawnMaxFor, validateGraphRecipe } from './graph';
import type { GraphBlock } from './types';

// Epo 2026-11-18: a formula row is stored as typed, unchecked for grammar.
it('takes formula rows as typed, an equation in x and y included', () => {
  const graph: GraphBlock = {
    board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
    elements: [
      { dash: true, id: 'f', latex: 'y=3x+10000', type: 'expression' },
      { hidden: true, id: 'g', latex: 'x^{2}-y^{2}=0', type: 'expression' },
    ],
    height: 240,
    type: 'graph',
    width: 320,
  };
  expect(() =>
    validateGraphRecipe(graph, QUESTION_GRAPH_ELEMENTS_MAX)
  ).not.toThrow();
});

it('takes the free marks and styles the canvas plane draws', () => {
  const graph: GraphBlock = {
    board: { axis: true, bbox: [-5, 5, 5, -5], grid: true, polar: true },
    elements: [
      { coords: [0, 0], id: 'A', type: 'point' },
      { coords: [2, 0], id: 'B', type: 'point' },
      { arrow: true, id: 'AB', points: ['A', 'B'], type: 'segment' },
      { coords: [1, 1], id: 't', size: 20, text: 'Area', type: 'text' },
      {
        arrow: true,
        coords: [
          [0, 0],
          [1, 2],
        ],
        id: 'v',
        type: 'polyline',
      },
      {
        coords: [
          [0, 0],
          [2, 1],
        ],
        handles: [
          [
            [0, 0],
            [1, 0],
          ],
          [
            [1, 1],
            [2, 1],
          ],
        ],
        id: 'c',
        type: 'curve',
      },
      { center: [0, 0], id: 'e', radii: [2, 1], type: 'ellipse' },
      {
        coords: [-2, 2],
        id: 'f',
        latex: '\\frac12',
        size: 24,
        type: 'formula',
      },
    ],
    height: 240,
    type: 'graph',
    width: 320,
  };
  expect(() =>
    validateGraphRecipe(graph, QUESTION_GRAPH_ELEMENTS_MAX)
  ).not.toThrow();
});

it('lets a canvas plane write every row, and a quiz or note graph the first up to the cap', () => {
  expect(drawnMaxFor(true)).toBe(Number.POSITIVE_INFINITY);
  expect(drawnMaxFor(false)).toBe(QUESTION_GRAPH_ELEMENTS_MAX);
});
