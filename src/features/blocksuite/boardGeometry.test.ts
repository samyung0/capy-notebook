import { expect, it } from 'vitest';
import {
  type FunctionMark,
  functionRuns,
  type PathMark,
  pathOf,
  smoothHandles,
} from './boardData';
import {
  clockAngle,
  minorStep,
  snapTo,
  ticks,
  type Vec,
} from './boardGeometry';

const curve = (points: Vec[], perSegment: number, handles?: [Vec, Vec][]) =>
  pathOf({ handles, id: 'c', kind: 'curve', points } as PathMark, perSegment);

it('lists a grid by index, and gives up on one no step can cross', () => {
  expect(ticks(-1, 3, 1)).toEqual([-1, 0, 1, 2, 3]);
  // Zoomed out, panned far, zoomed in: the step is too small to move this number.
  expect(ticks(2.75e11, 2.75e11 + 1e-3, 2e-6).length).toBeLessThanOrEqual(1000);
  expect(ticks(0, 1000, 1e-6)).toEqual([]);
  expect(ticks(Number.NaN, 1, 1)).toEqual([]);
});

it('snaps to the fine squares, which follow the numbered step', () => {
  expect(minorStep(1)).toBe(0.2);
  expect(minorStep(2)).toBe(0.5);
  expect(minorStep(50)).toBe(10);
  expect(snapTo(0.27, 0.1)).toBe(0.3);
});

it('passes through every plotted point', () => {
  const points: Vec[] = [
    [0, 0],
    [1, -1],
    [2, 0],
    [3, 3],
  ];
  const drawn = curve(points, 8);
  for (const [index, point] of points.entries())
    expect(drawn[index * 8]).toEqual(point);
});

it('bends where a handle is pulled, still through its points', () => {
  const points: Vec[] = [
    [0, 0],
    [2, 0],
    [4, 0],
  ];
  const handles = smoothHandles(points);
  // Smooth through three points in a row is the straight line.
  expect(curve(points, 4, handles)[2][1]).toBeCloseTo(0, 9);
  handles[0] = [handles[0][0], [0.5, 2]];
  const bent = curve(points, 4, handles);
  expect(bent[2][1]).toBeGreaterThan(0.5);
  expect(bent[4]).toEqual([2, 0]);
  expect(bent[8]).toEqual([4, 0]);
});

it('closes a loop without a corner where it ends on its start', () => {
  const drawn = curve(
    [
      [0, 0],
      [1, 1],
      [2, 0],
      [1, -1],
      [0, 0],
    ],
    8
  );
  const [start, next] = drawn;
  const [before, end] = drawn.slice(-2);
  const arriving = Math.atan2(end[1] - before[1], end[0] - before[0]);
  const leaving = Math.atan2(next[1] - start[1], next[0] - start[0]);
  // The turn between two short steps of the curve; without the loop, a 90° corner.
  expect(Math.abs(arriving - leaving)).toBeLessThan(0.6);
});

it("reads a pie angle clockwise from 12 o'clock", () => {
  const centre: Vec = [5, 5];
  for (const degrees of [0, 45, 126, 205, 290]) {
    const turn = (degrees * Math.PI) / 180;
    expect(
      clockAngle(centre, [5 + 3 * Math.sin(turn), 5 + 3 * Math.cos(turn)])
    ).toBe(degrees);
  }
});

const plotted = (term: string) =>
  functionRuns(
    { id: 'f', kind: 'function', latex: '', term } as FunctionMark,
    -5,
    5,
    0.04,
    16
  );

it('draws a steep line whole, and breaks a function at its asymptote', () => {
  expect(plotted('1000*x')).toHaveLength(1);
  expect(plotted('tan(x)').length).toBeGreaterThan(2);
  // A command's name reads as a call but plots nothing.
  expect(plotted('1+line(x)')).toEqual([]);
});

it("gives a loop's seam both handles, smooth across it", () => {
  const points: Vec[] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0],
  ];
  const handles = smoothHandles(points);
  expect(handles[0]).toEqual(handles[4]);
  const [[ax, ay], [bx, by]] = handles[0];
  // In and out lie on one line through the seam.
  expect(ax * by - ay * bx).toBeCloseTo(0);
});
