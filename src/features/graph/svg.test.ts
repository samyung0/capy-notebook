import { expect, it } from 'vitest';
import { drawGraph } from './draw';
import type { GraphElement, SizedGraph } from './model';
import { EXPORT_PAPER, PAPER } from './paper';
import { graphSvg, type Measure, SvgRecorder } from './svg';
import { validGraphSvg } from './validGraphSvg.testing';
import { PLANE_ZOOM, QUESTION_ZOOM } from './view';

/** Arial-ish widths: half the font size a character. */
const measure: Measure = (font, text) =>
  text.length * Number.parseFloat(font) * 0.5;

/** One of each kind and style, the plane's marks included. */
const everything: GraphElement[] = [
  { coords: [-2, -1], id: 'a', name: 'A', type: 'point' },
  { coords: [1, -1], id: 'b', name: 'B', type: 'point' },
  { coords: [-2, 2], id: 'c', name: 'C', type: 'point' },
  { coords: [2, 2], hidden: true, id: 'd', type: 'point' },
  { dash: true, id: 'f', latex: 'y=\\sin x+1', type: 'expression' },
  {
    id: 'g',
    latex: 'y=\\frac{1}{x}\\left\\lbrace 0.1\\le x\\le 4\\right\\rbrace',
    type: 'expression',
  },
  { id: 'h', latex: 'y=\\tan x', type: 'expression' },
  { id: 'i', latex: 'y=e^{x}', type: 'expression' },
  { id: 'q', latex: 'x^{2}-y^{2}=1', type: 'expression' },
  { id: 'l', points: ['a', 'd'], type: 'line' },
  { arrow: true, id: 's', points: ['a', 'b'], ticks: 2, type: 'segment' },
  { center: 'b', dash: true, id: 'ci', radius: 1, type: 'circle' },
  { id: 'an', label: 'θ', points: ['b', 'a', 'c'], type: 'angle' },
  { center: 'a', id: 'ar', points: ['b', 'c'], type: 'arc' },
  { center: 'a', id: 'se', points: ['c', 'b'], shade: true, type: 'sector' },
  { id: 'p', points: ['a', 'b', 'c'], shade: true, type: 'polygon' },
  {
    coords: [0, 3],
    id: 't',
    size: 18,
    text: 'A <label> & "quotes"',
    type: 'text',
  },
  {
    arrow: true,
    coords: [
      [0, 0],
      [1, 2],
      [3, 1],
    ],
    id: 'v',
    type: 'polyline',
  },
  {
    coords: [
      [-3, 0],
      [-2, 1],
      [-1, 0],
    ],
    id: 'cu',
    type: 'curve',
  },
  { center: [3, -2], id: 'e', radii: [1, 0.5], type: 'ellipse' },
  { coords: [-3, -3], id: 'fo', latex: 'x^2', type: 'formula' },
];

const graph = (over: Partial<SizedGraph> = {}): SizedGraph => ({
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
  elements: everything,
  height: 360,
  width: 480,
  ...over,
});

it('exports SVG the stored-SVG check admits, light whatever the theme', () => {
  const svg = graphSvg(graph(), measure);
  expect(validGraphSvg(svg)).toBe(true);
  expect(
    svg.startsWith(
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"'
    )
  ).toBe(true);
  expect(svg).toContain(`fill="${EXPORT_PAPER.paper}"`);
  expect(svg).toContain('&lt;label&gt; &amp; &quot;quotes&quot;');
  expect(
    validGraphSvg(
      graphSvg(
        graph({
          board: { axis: true, bbox: [-5, 5, 5, -5], grid: true, polar: true },
        }),
        measure
      )
    )
  ).toBe(true);
});

it('measures 100 functions on a 1200 px graph', () => {
  const svg = graphSvg(
    graph({
      elements: Array.from({ length: 100 }, (_, k) => ({
        id: `f${k}`,
        latex: `y=${(k - 50) / 10}+0.5\\sin\\left(${1 + (k % 7)}x\\right)`,
        type: 'expression' as const,
      })),
      height: 1200,
      width: 1200,
    }),
    measure
  );
  const bytes = new TextEncoder().encode(svg).length;
  // The 256 KiB cap no longer binds graphs (D11, D16): reported, not enforced.
  expect(bytes).toBeGreaterThan(100_000);
  expect(bytes).toBeLessThan(2_000_000);
});

const BROKEN = /NaN|Infinity/;

for (const [name, range] of [
  ['question editor', QUESTION_ZOOM],
  ['plane', PLANE_ZOOM],
] as const)
  for (const ppu of [range.min, range.max])
    it(`draws at the ${name}'s zoom of ${ppu} px a unit`, () => {
      for (const polar of [false, true]) {
        for (const centre of [0, 1234.5]) {
          const recorder = new SvgRecorder(480, 360, measure);
          drawGraph(
            recorder,
            { h: 360, w: 480, x: 0, y: 0 },
            {
              left: centre - 240 / ppu,
              ppuX: ppu,
              ppuY: ppu,
              top: centre + 180 / ppu,
            },
            graph({
              board: { axis: true, bbox: [-5, 5, 5, -5], grid: true, polar },
            }),
            PAPER.dark
          );
          const svg = recorder.toString();
          expect(svg).not.toMatch(BROKEN);
        }
      }
    });
