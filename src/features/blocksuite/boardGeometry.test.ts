import { expect, it } from 'vitest';
import {
  barBetween,
  clockAngle,
  minorStep,
  onCircle,
  smoothThrough,
  snapTo,
  type Vec,
} from './boardGeometry';

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

it('builds a bar up or down from the axis, wider only when dragged wider', () => {
  expect(barBetween([3.2, 0.4], [3.2, 5.1], 0.5, 1)).toEqual({
    h: 5,
    w: 1,
    x: 3,
  });
  expect(barBetween([3.2, 0], [6.1, 2], 0.5, 1).w).toBe(3);
  expect(barBetween([3.2, 0], [3.2, -2], 0.5, 1).h).toBe(-2);
});

it("reads a pie angle clockwise from 12 o'clock", () => {
  const centre: Vec = [5, 5];
  for (const degrees of [0, 45, 126, 205, 290])
    expect(clockAngle(centre, onCircle(centre, 3, degrees))).toBe(degrees);
});
