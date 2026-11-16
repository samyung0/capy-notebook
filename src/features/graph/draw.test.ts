import { describe, expect, it } from 'vitest';
import { wrapLabel } from './draw';
import type { GraphElement } from './model';
import { graphSvg, type Measure } from './svg';

/** Arial-ish widths: half the font size a character. */
const measure: Measure = (font, text) =>
  text.length * Number.parseFloat(font) * 0.5;

const point = (id: string, coords: [number, number]): GraphElement => ({
  coords,
  hidden: true,
  id,
  type: 'point',
});

/** The SVG of a 200 px square showing -2.5 to 2.5 (40 px a unit, the origin
 * at (100, 100)), with no axes or grid: only the elements' ink. */
const drawn = (...elements: GraphElement[]) =>
  graphSvg(
    {
      board: { axis: false, bbox: [-2.5, 2.5, 2.5, -2.5], grid: false },
      elements,
      height: 200,
      width: 200,
    },
    measure
  );

/** The ink's path data, stroked or filled. */
const ink = (svg: string) =>
  [...svg.matchAll(/<path d="([^"]+)"[^>]*(?:stroke|fill)="#000"/g)].map(
    (match) => match[1]
  );

describe('each element kind draws its path', () => {
  it('a point is a dot and its name sits beside it', () => {
    const svg = drawn({ coords: [0, 0], id: 'a', name: 'A', type: 'point' });
    expect(ink(svg)).toEqual([
      'M104.5 100A4.5 4.5 0 0 1 95.5 100A4.5 4.5 0 0 1 104.5 100',
    ]);
    expect(svg).toContain('x="106" y="96"');
    expect(svg).toContain('>A</text>');
  });

  it('a function runs across the view, a straight one thinned to its ends', () => {
    expect(ink(drawn({ id: 'f', term: 'x', type: 'functiongraph' }))).toEqual([
      'M0 200L200 0',
    ]);
    const parabola = ink(
      drawn({ id: 'f', term: 'x^2', type: 'functiongraph' })
    );
    expect(parabola).toHaveLength(1);
    expect(parabola[0].split(' ').length).toBeGreaterThan(40);
  });

  it('a function with a domain draws only over it, and breaks at an asymptote', () => {
    expect(
      ink(drawn({ domain: [0, 2], id: 'f', term: '1', type: 'functiongraph' }))
    ).toEqual(['M100 60L180 60']);
    const [hyperbola] = ink(
      drawn({ id: 'f', term: '1/x', type: 'functiongraph' })
    );
    expect(hyperbola.match(/M/g)).toHaveLength(2);
  });

  it('a line crosses the whole frame, a segment stops at its points', () => {
    const ends = [point('a', [0, 0]), point('b', [1, 1])];
    expect(
      ink(drawn(...ends, { id: 'l', points: ['a', 'b'], type: 'line' }))
    ).toEqual(['M-1 201L201 -1']);
    expect(
      ink(drawn(...ends, { id: 's', points: ['a', 'b'], type: 'segment' }))
    ).toEqual(['M100 100L140 60']);
  });

  it('a segment carries its equal-side marks and its arrowhead', () => {
    const ends = [point('a', [0, 0]), point('b', [2, 0])];
    const [stroke, marks] = ink(
      drawn(...ends, { id: 's', points: ['a', 'b'], ticks: 2, type: 'segment' })
    );
    expect(stroke).toBe('M100 100L180 100');
    expect(marks).toBe('M137.5 95L137.5 105M142.5 95L142.5 105');
    const [shaft, head] = ink(
      drawn(...ends, {
        arrow: true,
        id: 's',
        points: ['a', 'b'],
        type: 'segment',
      })
    );
    expect(shaft).toBe('M100 100L174.6 100');
    expect(head).toBe('M180 100L169.2 105.2 169.2 94.8Z');
  });

  it('a circle, an arc and a sector go round their centre', () => {
    const o = point('o', [0, 0]);
    const p = point('p', [1, 0]);
    const q = point('q', [0, 1]);
    expect(
      ink(drawn(o, { center: 'o', id: 'c', radius: 1, type: 'circle' }))
    ).toEqual(['M140 100A40 40 0 0 1 60 100A40 40 0 0 1 140 100']);
    // Counterclockwise from p round to q: a quarter, up on the screen.
    expect(
      ink(
        drawn(o, p, q, {
          center: 'o',
          id: 'a',
          points: ['p', 'q'],
          type: 'arc',
        })
      )
    ).toEqual(['M140 100A40 40 0 0 0 100 60']);
    const svg = drawn(o, p, q, {
      center: 'o',
      id: 's',
      points: ['q', 'p'],
      shade: true,
      type: 'sector',
    });
    expect(ink(svg)).toEqual([
      'M100 100L100 60A40 40 0 1 0 140 100Z',
      'M100 100L100 60A40 40 0 1 0 140 100Z',
    ]);
    expect(svg).toContain('fill-opacity="0.15"');
  });

  it('an angle draws its arc, or its square at 90°, with its label inside', () => {
    const corner = [point('a', [1, 0]), point('o', [0, 0]), point('b', [0, 1])];
    const square = drawn(...corner, {
      id: 'r',
      label: '90°',
      points: ['a', 'o', 'b'],
      type: 'angle',
    });
    expect(ink(square)).toEqual(['M116.8 100L116.8 83.2 100 83.2']);
    expect(square).toContain('>90°</text>');
    const acute = drawn(
      point('a', [1, 0]),
      point('o', [0, 0]),
      point('b', [1, 1]),
      { id: 't', points: ['a', 'o', 'b'], type: 'angle' }
    );
    expect(ink(acute)).toEqual(['M124 100A24 24 0 0 0 117 83']);
  });

  it('a polygon closes, shaded when asked', () => {
    const corners = [
      point('a', [0, 0]),
      point('b', [1, 0]),
      point('c', [0, 1]),
    ];
    const svg = drawn(...corners, {
      id: 'p',
      points: ['a', 'b', 'c'],
      shade: true,
      type: 'polygon',
    });
    expect(ink(svg)).toEqual([
      'M100 100L140 100 100 60Z',
      'M100 100L140 100 100 60Z',
    ]);
    expect(svg).toContain('fill-opacity="0.15"');
  });

  it('a label is text centred on its point, wrapped and haloed', () => {
    const svg = drawn({ coords: [0, 0], id: 't', text: 'Label', type: 'text' });
    expect(svg).toContain(
      '<text x="100" y="100" font-family="Arial, sans-serif" font-size="15" text-anchor="middle" dominant-baseline="central" stroke="#fff"'
    );
    const long = drawn({
      coords: [0, 0],
      id: 't',
      // 7.5 px a character: 26 fit the 200 px line.
      text: 'Surface area to volume ratio falls as cells grow',
      type: 'text',
    });
    expect([...long.matchAll(/<text /g)]).toHaveLength(2);
  });

  it('the plane’s marks: a vector, a curve, an ellipse', () => {
    expect(
      ink(
        drawn({
          arrow: true,
          coords: [
            [0, 0],
            [2, 0],
          ],
          id: 'v',
          type: 'polyline',
        })
      )
    ).toEqual(['M100 100L174.6 100', 'M180 100L169.2 105.2 169.2 94.8Z']);
    const [curve] = ink(
      drawn({
        coords: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
        id: 'c',
        type: 'curve',
      })
    );
    expect(curve.match(/C/g)).toHaveLength(2);
    expect(
      ink(drawn({ center: [0, 0], id: 'e', radii: [2, 1], type: 'ellipse' }))
    ).toEqual(['M180 100A80 40 0 0 1 20 100A80 40 0 0 1 180 100']);
  });

  it('a formula waits for its layout without failing', () => {
    expect(() =>
      drawn({ coords: [0, 0], id: 'f', latex: '\\frac12', type: 'formula' })
    ).not.toThrow();
  });

  it('a hidden element draws nothing, a dashed one dashes', () => {
    expect(
      ink(drawn({ hidden: true, id: 'f', term: 'x', type: 'functiongraph' }))
    ).toEqual([]);
    expect(
      drawn({ dash: true, id: 'f', term: 'x', type: 'functiongraph' })
    ).toContain('stroke-dasharray="7 5"');
  });
});

it('draws the grid and numbered axes, the numbers leaving with their axis', () => {
  const board = (bbox: [number, number, number, number]) =>
    graphSvg(
      {
        board: { axis: true, bbox, grid: true },
        elements: [],
        height: 200,
        width: 200,
      },
      measure
    );
  const centred = board([-5, 5, 5, -5]);
  expect(centred).toContain('>4</text>');
  expect(centred).toContain('>–4</text>');
  // x from 100 to 110: the y axis and its numbers are out of view.
  const away = board([100, 60, 110, 50]);
  expect(away).not.toContain('<text');
});

it('wraps labels at word breaks, splitting words wider than a line', () => {
  // 10px per character: 20 characters fit the 200px line.
  const width = (line: string) => line.length * 10;
  expect(wrapLabel('Surface area : volume ratio (per µm)', width)).toEqual([
    'Surface area :',
    'volume ratio (per',
    'µm)',
  ]);
  expect(
    wrapLabel('表面積與體積之比隨細胞邊長增加而迅速下降並趨近於零', width)
  ).toEqual(['表面積與體積之比隨細胞邊長增加而迅速下降', '並趨近於零']);
  expect(wrapLabel('short', width)).toEqual(['short']);
});
