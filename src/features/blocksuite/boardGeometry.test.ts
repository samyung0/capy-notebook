import { expect, it } from 'vitest';
import {
  coordinates,
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
