import { expect, it } from 'vitest';
import {
  clockAngle,
  curvePieces,
  minorStep,
  smoothThrough,
  snapTo,
  ticks,
  type Vec,
} from './boardGeometry';

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
  const curve = smoothThrough(points, 8);
  for (const [index, point] of points.entries())
    expect(curve[index * 8]).toEqual(point);
});

it('draws the same curve as smooth Bézier pieces', () => {
  const points: Vec[] = [
    [0, 0],
    [1, -1],
    [2, 0],
    [3, 3],
  ];
  const sampled = smoothThrough(points, 2);
  for (const [i, [from, c1, c2, to]] of curvePieces(points).entries()) {
    expect(from).toEqual(points[i]);
    expect(to).toEqual(points[i + 1]);
    const middle = [0, 1].map(
      (axis) => (from[axis] + 3 * c1[axis] + 3 * c2[axis] + to[axis]) / 8
    );
    expect(middle[0]).toBeCloseTo(sampled[i * 2 + 1][0], 9);
    expect(middle[1]).toBeCloseTo(sampled[i * 2 + 1][1], 9);
  }
});

it('closes a loop without a corner where it ends on its start', () => {
  const curve = smoothThrough(
    [
      [0, 0],
      [1, 1],
      [2, 0],
      [1, -1],
      [0, 0],
    ],
    8
  );
  const [start, next] = curve;
  const [before, end] = curve.slice(-2);
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
