import { describe, expect, it } from 'vitest';
import {
  circleAt,
  distanceTo,
  ellipseHandles,
  movedGroup,
  pointsById,
  pullEllipse,
  withDependents,
} from './marks';
import type { GraphElement } from './model';
import type { View } from './view';

/** 40 px a unit, (0, 10) at the top left. */
const view: View = { left: 0, ppuX: 40, ppuY: 40, top: 10 };

const triangle: GraphElement[] = [
  { coords: [1, 1], id: 'A', name: 'A', type: 'point' },
  { coords: [5, 1], id: 'B', name: 'B', type: 'point' },
  { coords: [1, 4], id: 'C', name: 'C', type: 'point' },
  { id: 'AB', points: ['A', 'B'], type: 'segment' },
  { center: 'A', id: 'cA', radius: 2, type: 'circle' },
  { id: 'ABC', points: ['A', 'B', 'C'], type: 'polygon' },
  { coords: [7, 7], id: 'free', type: 'point' },
];

describe('distanceTo', () => {
  const points = pointsById(triangle);
  const near = (id: string, px: [number, number]) =>
    distanceTo(
      triangle.find((element) => element.id === id) as GraphElement,
      px,
      view,
      points,
      12
    );

  it('measures a construction in screen pixels through the points it names', () => {
    // The segment from (40, 360) to (200, 360).
    expect(near('AB', [120, 366])).toBeCloseTo(6);
    // The circle round A at 80 px, above its top.
    expect(near('cA', [40, 277])).toBeCloseTo(3);
    // The polygon's closing side, C to A.
    expect(near('ABC', [44, 300])).toBeCloseTo(4);
  });
});

describe('movedGroup', () => {
  it('moves a construction by the points it is built on, each once', () => {
    const moved = movedGroup(triangle, new Set(['AB', 'A']), [1, 0]);
    expect(moved.map((element) => element.id)).toEqual(['A', 'B']);
    expect(moved).toContainEqual({
      coords: [2, 1],
      id: 'A',
      name: 'A',
      type: 'point',
    });
  });
});

describe('withDependents', () => {
  it('takes what is built on a point with it', () => {
    expect([...withDependents(triangle, new Set(['C']))]).toEqual(['C', 'ABC']);
  });
});

describe('pullEllipse', () => {
  const circle = circleAt('e', [1, 1], 2);

  it('holds an ellipse by its right, top, left and bottom handles', () => {
    expect(ellipseHandles(circle)).toEqual([
      [3, 1],
      [1, 3],
      [-1, 1],
      [1, -1],
    ]);
  });

  it('sizes about its middle, staying upright and on the grid', () => {
    expect(pullEllipse(circle, 0, [4, 0])).toEqual({
      ...circle,
      radii: [3, 2],
    });
    expect(pullEllipse(circle, 3, [1, 0])).toEqual({
      ...circle,
      radii: [2, 1],
    });
  });

  it('keeps its shape when uniform', () => {
    expect(
      pullEllipse({ ...circle, radii: [2, 1] }, 2, [-3, 1], true).radii
    ).toEqual([4, 2]);
  });
});
