import { expect, it } from 'vitest';
import { functionReach } from './curves';
import { fitMarks, fitPressed, fitWindow } from './fit';
import type { GraphElement } from './model';

const SIZE = { max: 1200, minH: 120, minW: 120 };

// Epo 2026-11-18: a graph figure fits on leaving as a plane card does, round
// its marks with 40 px to spare, at its own scale; not round the origin, as
// other apps fit to what is drawn.
it('frames the marks at the given scale', () => {
  const fitted = fitMarks(
    [
      { coords: [2, 3], id: 'a', type: 'point' },
      { coords: [8, -1], id: 'b', type: 'point' },
    ],
    { x: 20, y: 20 },
    SIZE,
    { x: [-5, 5], y: [-5, 5] }
  );
  expect(fitted).toEqual({
    h: 160,
    ppu: { x: 20, y: 20 },
    spread: true,
    w: 200,
    x0: 0,
    y0: 5,
  });
});

it('zooms out instead of growing past the largest side', () => {
  const fitted = fitMarks(
    [
      { coords: [0, 0], id: 'near', type: 'point' },
      { coords: [100, 0], id: 'far', type: 'point' },
    ],
    { x: 20, y: 40 },
    SIZE,
    { x: [-5, 5], y: [-5, 5] }
  );
  expect(fitted?.w).toBe(1200);
  // (1200 - 80) / 100 units across; the y scale keeps its ratio.
  expect(fitted?.ppu.x).toBeCloseTo(11.2);
  expect(fitted?.ppu.y).toBeCloseTo(22.4);
});

const reachY = (latex: string) => {
  const ys = functionReach({ latex }, -5, 5)?.ys ?? [];
  return [Math.min(...ys), Math.max(...ys)];
};

// Epo 2026-11-18: an asymptote's spikes are left out (Tukey's far fences),
// while a function that runs unbroken keeps all of itself.
it("frames 1/x's body and all of e^x", () => {
  const [low, high] = reachY('y=\\frac{1}{x}');
  expect(high).toBeLessThan(3);
  expect(low).toBeGreaterThan(-3);
  expect(reachY('y=e^{x}')[1]).toBeCloseTo(Math.exp(5));
});

// What is shown counts less the 40 px a fit leaves round it: −7…7 at 20 px a
// unit is −5…5.
it('fits a plane of functions alone over the x range shown', () => {
  const fitted = fitMarks(
    [{ id: 'f', latex: 'y=\\sin x', type: 'expression' }],
    { x: 20, y: 20 },
    SIZE,
    { x: [-7, 7], y: [-7, 7] }
  );
  expect(fitted?.w).toBe(280);
  expect(fitted?.h).toBe(120);
});

it('counts a steep function only within the y range shown', () => {
  const fitted = fitMarks(
    [{ id: 'f', latex: 'y=x^{2}-3', type: 'expression' }],
    { x: 20, y: 20 },
    SIZE,
    { x: [-7, 7], y: [-7, 7] }
  );
  // y from x² − 3's lowest, −3, to the top shown, 5, which it runs past:
  // 160 px and 40 round, not the 56 it reaches at x = 5.
  expect(fitted?.h).toBe(240);
  expect(fitted?.y0).toBe(7);
});

// A fit fitted again keeps its frame (it once grew by its own room each time).
// tan, its curves leaving the top and bottom shown, once drifted in by a step.
it('keeps a fitted frame when fitted again', () => {
  const marks = [{ id: 'f', latex: 'y=\\tan x', type: 'expression' as const }];
  const once = fitMarks(marks, { x: 20, y: 20 }, SIZE, {
    x: [-5, 5],
    y: [-5, 5],
  });
  if (!once) throw new Error('no fit');
  const again = fitMarks(marks, once.ppu, SIZE, {
    x: [once.x0, once.x0 + once.w / once.ppu.x],
    y: [once.y0 - once.h / once.ppu.y, once.y0],
  });
  expect(again?.w).toBeCloseTo(once.w);
  expect(again?.h).toBeCloseTo(once.h);
});

it('keeps a narrow smooth peak whole', () => {
  const [, high] = reachY('y=100e^{-\\left(\\frac{x-0.03}{0.02}\\right)^{2}}');
  // Its samples straddle the peak (10.5 at x = 0); none is dropped as a spike.
  expect(high).toBeGreaterThan(10);
});

it('frames a line far from the origin where it is', () => {
  const fitted = fitMarks(
    [{ id: 'f', latex: 'y=x+100000', type: 'expression' }],
    { x: 40, y: 40 },
    SIZE,
    { x: [-7.5, 7.5], y: [99_995, 100_005] }
  );
  // At its own scale, round 99996…100004 shown (less the room), not 0.
  expect(fitted?.ppu.y).toBe(40);
  expect(fitted?.y0).toBeCloseTo(100_005);
});

it('moves to a function that never reaches what is shown', () => {
  const fitted = fitMarks(
    [{ id: 'f', latex: 'y=3x+10000', type: 'expression' }],
    { x: 30, y: 30 },
    SIZE,
    { x: [-1, 15], y: [-3.2, 7.5] }
  );
  if (!fitted) throw new Error('no fit');
  // Over x 0.33…13.67 shown, y runs 10001…10041: framed there.
  expect(fitted.y0).toBeGreaterThan(10_041);
  expect(fitted.y0 - fitted.h / fitted.ppu.y).toBeLessThan(10_001);
});

it('keeps the frame for a steep line crossing between samples', () => {
  const fitted = fitMarks(
    [{ id: 'f', latex: 'y=100x+10', type: 'expression' }],
    { x: 30, y: 30 },
    SIZE,
    { x: [-10, 10], y: [-5, 5] }
  );
  // No sample lands in −3.67…3.67, yet the line crosses it: kept, not 2000 tall.
  expect(fitted?.h).toBeCloseTo(300);
});

// Epo 2026-11-18: an implicit curve counts where it is found in what is shown.
it('frames an equation round the curve it draws', () => {
  const fitted = fitMarks(
    [{ id: 'c', latex: 'x^2+y^2=4', type: 'expression' }],
    { x: 20, y: 20 },
    SIZE,
    { x: [-7, 7], y: [-7, 7] }
  );
  // The circle, 4 units across at 20 px, and 40 px round.
  expect(fitted?.w).toBeCloseTo(160, 0);
  expect(fitted?.h).toBeCloseTo(160, 0);
  expect(fitted?.x0).toBeCloseTo(-4, 1);
});

// A closed part of an implicit curve counts whole, as other apps fit to what
// is drawn; a part running off keeps the edge shown, as a function does.
it('frames a circle crossing the shown edge whole, beside lines that run off', () => {
  const marks: GraphElement[] = [
    { id: 'l', latex: 'x^2-y^2=0', type: 'expression' },
    { id: 'c', latex: 'x^2+y^2=16', type: 'expression' },
  ];
  const box = fitWindow(
    marks,
    { height: 320, width: 480 },
    [-1, 7.47, 15, -3.2],
    SIZE
  );
  if (!box) throw new Error('no fit');
  const [left, top, right, bottom] = box;
  expect(left).toBeLessThan(-4);
  expect(right).toBeGreaterThan(4);
  expect(bottom).toBeLessThan(-4);
  expect(top).toBeGreaterThan(4);
});

it('keeps the frame of lines that run off when fitted again', () => {
  const marks: GraphElement[] = [
    { id: 'l', latex: 'x^2-y^2=0', type: 'expression' },
  ];
  const once = fitMarks(marks, { x: 20, y: 20 }, SIZE, {
    x: [-1, 15],
    y: [-3, 7],
  });
  if (!once) throw new Error('no fit');
  const again = fitMarks(marks, once.ppu, SIZE, {
    x: [once.x0, once.x0 + once.w / once.ppu.x],
    y: [once.y0 - once.h / once.ppu.y, once.y0],
  });
  expect(again?.w).toBeCloseTo(once.w);
  expect(again?.h).toBeCloseTo(once.h);
  expect(again?.x0).toBeCloseTo(once.x0);
  expect(again?.y0).toBeCloseTo(once.y0);
});

// Epo 2026-11-18 ("keep size is much better"): a figure keeps its size and the
// window fits its marks, centred, units kept, settling in one fit.
it('fits the window inside the figure, settled in one fit', () => {
  const marks: GraphElement[] = [
    { coords: [2, 3], id: 'a', type: 'point' },
    { coords: [8, -1], id: 'b', type: 'point' },
  ];
  const size = { height: 400, width: 600 };
  const once = fitWindow(marks, size, [-7.5, 5, 7.5, -5], SIZE);
  // 40 px round the points at the scale that fills 600 × 400: 80 px a unit.
  expect(once?.map((value) => Number(value.toFixed(6)))).toEqual([
    1.25, 3.5, 8.75, -1.5,
  ]);
  if (!once) throw new Error('no fit');
  const again = fitWindow(marks, size, once, SIZE) ?? [];
  for (const [i, value] of once.entries())
    expect(again[i]).toBeCloseTo(value, 6);
});

it('frames a lone point at the scale it has', () => {
  const box = fitWindow(
    [{ coords: [3, 4], id: 'p', type: 'point' }],
    { height: 400, width: 600 },
    [-10, 10, 10, -10],
    SIZE
  );
  // 30 px a unit across and 20 up, as the figure showed it, centred on (3, 4).
  expect(box?.map((value) => Number(value.toFixed(6)))).toEqual([
    -7, 14, 13, -6,
  ]);
});

// Epo 2026-11-18: the editor's Fit frames as Fit to size does, so a second
// press changes nothing (it once zoomed out by its margin each time).
it('settles the Fit button in one press', () => {
  const window = { height: 320, width: 480 };
  for (const latex of ['y=x^{2}', 'x^2+y^2=16']) {
    const marks: GraphElement[] = [{ id: 'f', latex, type: 'expression' }];
    const once = fitPressed(marks, window, [-1, 7.47, 15, -3.2], 10);
    const twice = fitPressed(marks, window, once, 10);
    for (const [i, edge] of once.entries())
      expect(twice[i]).toBeCloseTo(edge, 6);
  }
});

it('fits an empty graph to ten units round the origin', () => {
  expect(
    fitPressed([], { height: 320, width: 480 }, [-1, 7.47, 15, -3.2], 10)
  ).toEqual([-5, 5, 5, -5]);
});
