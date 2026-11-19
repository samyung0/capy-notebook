import { expect, it } from 'vitest';
import {
  axisNumber,
  bboxOf,
  PLANE_ZOOM,
  panned,
  QUESTION_ZOOM,
  revealed,
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

// Epo 2026-11-18 ("Move the view"): a typed function wholly off the view
// brings the view to it; one shown, or crossing it, leaves it be.
it('moves the view to a typed function off it', () => {
  const near = viewOf([-1, 7.5, 15, -3.2], 480, 320);
  const moved = revealed({ latex: 'y=3x+10000' }, near, 480, 320);
  // Its middle value over x −1…15 is 10021, in the middle, at the same scale.
  expect(moved?.ppuY).toBe(near.ppuY);
  expect(moved && moved.top - 160 / moved.ppuY).toBeCloseTo(10_021);
  expect(revealed({ latex: 'y=x^{2}' }, near, 480, 320)).toBeNull();
  expect(revealed({ latex: 'y=1000x' }, near, 480, 320)).toBeNull();
});
