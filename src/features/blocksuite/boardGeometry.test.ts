import { expect, it } from 'vitest';
import {
  clockAngle,
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

it("reads a pie angle clockwise from 12 o'clock", () => {
  const centre: Vec = [5, 5];
  for (const degrees of [0, 45, 126, 205, 290]) {
    const turn = (degrees * Math.PI) / 180;
    expect(
      clockAngle(centre, [5 + 3 * Math.sin(turn), 5 + 3 * Math.cos(turn)])
    ).toBe(degrees);
  }
});
