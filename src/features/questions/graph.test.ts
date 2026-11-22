import { expect, it } from 'vitest';
import { QUESTION_GRAPH_ELEMENTS_MAX } from '@/api/limits.generated';
import { validateGraphRecipe } from './graph';
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
  expect(() => validateGraphRecipe(graph)).not.toThrow();
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
  expect(() => validateGraphRecipe(graph)).not.toThrow();
});

// Epo 2026-11-22: every surface takes up to twice the element cap.
it('takes a graph two adds merged past the element cap, up to twice it', () => {
  const graph = (count: number): GraphBlock => ({
    board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
    elements: Array.from({ length: count }, (_, i) => ({
      coords: [0, 0] as [number, number],
      id: `P${i}`,
      type: 'point' as const,
    })),
    height: 240,
    type: 'graph',
    width: 320,
  });
  for (const count of [
    QUESTION_GRAPH_ELEMENTS_MAX + 1,
    2 * QUESTION_GRAPH_ELEMENTS_MAX,
  ])
    expect(() => validateGraphRecipe(graph(count))).not.toThrow();
  expect(() =>
    validateGraphRecipe(graph(2 * QUESTION_GRAPH_ELEMENTS_MAX + 1))
  ).toThrow();
});
