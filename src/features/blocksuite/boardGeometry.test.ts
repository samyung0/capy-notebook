import { expect, it } from 'vitest';
import {
  barBetween,
  clockAngle,
  coordinates,
  onCircle,
  SHEET,
  smoothThrough,
  snapToGrid,
  UNIT,
} from './boardGeometry';

const at = (x: number, y: number): [number, number] => [
  SHEET.origin.x + x * UNIT.x,
  SHEET.origin.y - y * UNIT.y,
];

it('snaps a click to the nearest grid crossing and reads its coordinates', () => {
  const [x, y] = at(3, -1);
  const snapped = snapToGrid([x + 8, y - 12]);
  expect(snapped).toEqual(at(3, -1));
  expect(coordinates(at(3, -1))).toBe('(3, −1)');
});

it('passes through every plotted point', () => {
  const points = [at(0, 0), at(1, -1), at(2, 0), at(3, 3)];
  const curve = smoothThrough(points, 8);
  for (const [index, point] of points.entries())
    expect(curve[index * 8]).toEqual(point);
});

it('builds a bar up from the axis, one column wide unless dragged wider', () => {
  const [x, y] = at(3, 0);
  expect(barBetween([x + 10, y - 5], at(3, 5))).toMatchObject({
    height: 5,
    w: UNIT.x,
    x,
  });
  expect(barBetween([x + 10, y - 5], at(6, 2)).w).toBe(3 * UNIT.x);
  const below = barBetween([x + 10, y], at(3, -2));
  expect([below.height, below.y]).toEqual([-2, SHEET.origin.y]);
});

it("reads a pie angle clockwise from 12 o'clock", () => {
  const centre = at(5, 5);
  for (const degrees of [0, 45, 126, 205, 290])
    expect(clockAngle(centre, onCircle(centre, 100, degrees))).toBe(degrees);
});
