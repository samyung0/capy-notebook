import { expect, it } from 'vitest';
import { validateGraphRecipe } from './graph';
import type { GraphBlock } from './types';
import { validGraphTerm } from './validation';

it('accepts arithmetic functions but not property access or statements', () => {
  expect(validGraphTerm('sin(x) + 2.5*x^2')).toBe(true);
  for (const term of [
    'x.constructor',
    'alert(x)',
    'x;while(1){}',
    'x=2',
    'x[0]',
    'Math.sin(x)',
  ])
    expect(validGraphTerm(term)).toBe(false);
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
