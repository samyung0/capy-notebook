import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DrawContext } from '@/features/graph/draw';
import { drawGraph } from '@/features/graph/draw';
import type { GraphElement } from '@/features/graph/model';
import { EXPORT_PAPER, PAPER } from '@/features/graph/paper';
import { viewOf } from '@/features/graph/view';
import { paintGraph } from '@/features/questions/graphPaint';
import type { GraphBlock } from '@/features/questions/types';
import { drawPlane } from './boardPlane';

/* One renderer for every graph (Epo 2026-11-16): the quiz, note and bank view
 * (`paintGraph`), the canvas plane (`drawPlane`) and the engine called
 * directly make the same canvas calls for the same elements, so a change to
 * the engine's drawing shows on all of them. */

type Call = [string, ...unknown[]];

/** A canvas context that records every call and every style it is given. */
function recorder() {
  const calls: Call[] = [];
  const styles: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_, key: string) => {
        if (key in styles) return styles[key];
        if (key === 'measureText')
          return (text: string) => ({ width: text.length * 7 });
        return (...args: unknown[]) => {
          calls.push([key, ...args]);
        };
      },
      set: (_, key: string, value) => {
        styles[key] = value;
        calls.push([`${key}=`, value]);
        return true;
      },
    }
  );
  return { calls, ctx: ctx as DrawContext & CanvasRenderingContext2D };
}

const WIDTH = 400;
const HEIGHT = 300;
/** 40 px a unit on both axes, as a plane has: x from -5 to 5. */
const PPU = 40;
const bbox: [number, number, number, number] = [-5, 3.75, 5, -3.75];

const elements: GraphElement[] = [
  { id: 'f', term: 'x^2 - 2', type: 'functiongraph' },
  { coords: [-2, 1], id: 'a', name: 'A', type: 'point' },
  { coords: [2, 1], id: 'b', name: 'B', type: 'point' },
  { coords: [0, 3], id: 'c', name: 'C', type: 'point' },
  { id: 'l', points: ['a', 'b'], type: 'line' },
  { id: 's', points: ['a', 'c'], type: 'segment' },
  { center: 'a', id: 'k', radius: 1, type: 'circle' },
  { id: 'n', points: ['b', 'a', 'c'], type: 'angle' },
  { id: 'p', points: ['a', 'b', 'c'], type: 'polygon' },
  { coords: [1, -2], id: 't', text: 'Turning point', type: 'text' },
  {
    arrow: true,
    coords: [
      [-4, -3],
      [-3, -2],
    ],
    id: 'v',
    type: 'polyline',
  },
  {
    coords: [
      [3, -3],
      [4, -1],
      [3, 0],
    ],
    id: 'u',
    type: 'curve',
  },
  { center: [3, 2], id: 'e', radii: [1, 0.5], type: 'ellipse' },
];

const block: GraphBlock = {
  board: { axis: true, bbox, grid: true },
  elements,
  height: HEIGHT,
  type: 'graph',
  width: WIDTH,
};

const frame = { h: HEIGHT, w: WIDTH, x: 0, y: 0 };

/** The engine called directly on `paper`. */
function engine(paper = PAPER.light) {
  const { calls, ctx } = recorder();
  drawGraph(ctx, frame, viewOf(bbox, WIDTH, HEIGHT), block, paper);
  return calls;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect() {
        // Nothing observed in the test.
      }
      observe() {
        // The first paint is made at once.
      }
    }
  );
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

it('the quiz, note and bank view draws exactly what the engine draws, light and dark', () => {
  for (const dark of [false, true]) {
    const { calls, ctx } = recorder();
    const canvas = {
      clientWidth: WIDTH,
      getContext: () => ctx,
      height: 0,
      width: 0,
    } as unknown as HTMLCanvasElement;
    paintGraph(canvas, block, dark)();
    // Its own part: the canvas's scale for the screen.
    expect(calls[0]).toEqual(['setTransform', 1, 0, 0, 1, 0, 0]);
    expect(calls.slice(1)).toEqual(engine(dark ? PAPER.dark : PAPER.light));
  }
});

it('the canvas plane draws exactly what the engine draws', () => {
  const { calls, ctx } = recorder();
  drawPlane(ctx, frame, { ppu: PPU, x0: bbox[0], y0: bbox[1] }, elements, {
    ...PAPER.light,
  });
  expect(calls).toEqual(engine());
});

it('an export differs from the screen only in its paper colour', () => {
  const screen = engine();
  const exported = engine(EXPORT_PAPER);
  expect(exported).toHaveLength(screen.length);
  // The paper itself and the halo of paper behind numbers and labels.
  const differing = screen.flatMap((call, i) =>
    JSON.stringify(call) === JSON.stringify(exported[i])
      ? []
      : [[call[1], exported[i][1]]]
  );
  expect(differing.length).toBeGreaterThan(0);
  expect(new Set(differing.map((pair) => JSON.stringify(pair)))).toEqual(
    new Set([JSON.stringify([PAPER.light.paper, EXPORT_PAPER.paper])])
  );
});
