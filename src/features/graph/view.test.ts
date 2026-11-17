import { expect, it } from 'vitest';
import {
  axisNumber,
  bboxOf,
  elementBounds,
  framed,
  PLANE_ZOOM,
  panned,
  QUESTION_ZOOM,
  snapped,
  tickStep,
  toPlane,
  toScreen,
  viewOf,
  zoomedAt,
} from './view';

const view = viewOf([-5, 5, 5, -5], 200, 100);

it('turns a bbox into a camera and back', () => {
  expect(view).toEqual({ left: -5, ppuX: 20, ppuY: 10, top: 5 });
  expect(bboxOf(view, 200, 100)).toEqual([-5, 5, 5, -5]);
  expect(toScreen(view, [0, 0])).toEqual([100, 50]);
  expect(toPlane(view, [100, 50])).toEqual([0, 0]);
  expect(toPlane(view, toScreen(view, [2.5, -1]))).toEqual([2.5, -1]);
});

it('pans by screen pixels and zooms about the pointer', () => {
  expect(bboxOf(panned(view, 20, -10), 200, 100)).toEqual([-6, 4, 4, -6]);
  const zoomed = zoomedAt(view, 2, [150, 25], QUESTION_ZOOM);
  expect(zoomed.ppuX).toBe(40);
  expect(zoomed.ppuY).toBe(20);
  // The plane point under the pointer stays there.
  expect(toPlane(zoomed, [150, 25])).toEqual(toPlane(view, [150, 25]));
});

it('stops each surface at its own zoom range', () => {
  const tight = zoomedAt(view, 1e9, [0, 0], PLANE_ZOOM);
  expect(Math.max(tight.ppuX, tight.ppuY)).toBeCloseTo(1e6);
  const wide = zoomedAt(view, 1e-12, [0, 0], PLANE_ZOOM);
  expect(Math.min(wide.ppuX, wide.ppuY)).toBeCloseTo(1e-6);
  const far = zoomedAt(view, 1e20, [0, 0], QUESTION_ZOOM);
  expect(Math.max(far.ppuX, far.ppuY) / 1e15).toBeCloseTo(1);
});

it('lands dragged points on the view’s precision', () => {
  expect(snapped(viewOf([-5, 5, 5, -5], 400, 400), [1.234, -2.06])).toEqual([
    1.2, -2.1,
  ]);
  expect(
    snapped(viewOf([0, 0.1, 0.1, 0], 400, 400), [0.012_34, 0.0567])
  ).toEqual([0.012, 0.057]);
});

it('numbers axes like GeoGebra', () => {
  // 100px per number rounded down to 1, 2 or 5 × 10ⁿ.
  expect(tickStep(77)).toBe(1);
  expect(tickStep(30)).toBe(2);
  expect(tickStep(0.15)).toBe(500);
  expect(tickStep(4e7)).toBe(2e-6);
  expect(axisNumber(2010, 5)).toBe('2010');
  expect(axisNumber(-0.25, 0.05)).toBe('–0.25');
  expect(axisNumber(5e8, 5e8)).toBe('5E8');
  expect(axisNumber(-1.5e-6, 5e-7)).toBe('–1.5E-6');
  expect(axisNumber(0, 2)).toBe('');
});

it('frames every element with a margin, keeping the units’ ratio', () => {
  const graph = {
    board: {
      axis: true,
      bbox: [-5, 5, 5, -5] as [number, number, number, number],
      grid: true,
    },
    elements: [
      { coords: [0, 0] as [number, number], id: 'a', type: 'point' as const },
      { coords: [10, 4] as [number, number], id: 'b', type: 'point' as const },
      { center: 'b', id: 'c', radius: 1, type: 'circle' as const },
    ],
  };
  const box = elementBounds(graph, graph.board.bbox);
  for (const [i, edge] of [-1.1, 5.5, 12.1, -0.5].entries())
    expect(box?.[i]).toBeCloseTo(edge);
  const fitted = framed(box ?? graph.board.bbox, view, 200, 100);
  expect(fitted.ppuX / fitted.ppuY).toBeCloseTo(view.ppuX / view.ppuY);
  const [l, t, r, b] = bboxOf(fitted, 200, 100);
  expect(l).toBeLessThanOrEqual(-1.09);
  expect(r).toBeGreaterThanOrEqual(12.09);
  expect(t).toBeGreaterThanOrEqual(5.49);
  expect(b).toBeLessThanOrEqual(-0.49);
});
