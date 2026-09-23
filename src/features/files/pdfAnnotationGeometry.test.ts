import { describe, expect, it } from 'vitest';
import {
  eraseRects,
  eraserIntersectsPen,
  eraserIntersectsRect,
  fullyHighlighted,
  rotateRect,
} from './pdfAnnotationGeometry';

describe('private PDF geometry', () => {
  it('erases pen segments only when the swept circle reaches actual ink', () => {
    const stroke = [
      { x: 0, y: 0 },
      { x: 0, y: 400 },
      { x: 400, y: 400 },
    ];
    expect(
      eraserIntersectsPen({ x: 200, y: 200 }, { x: 200, y: 200 }, stroke, 48)
    ).toBe(false);
    expect(
      eraserIntersectsPen({ x: -100, y: 200 }, { x: 100, y: 200 }, stroke, 48)
    ).toBe(true);
    expect(
      eraserIntersectsPen({ x: 48, y: 100 }, { x: 48, y: 200 }, stroke, 48)
    ).toBe(true);
    expect(
      eraserIntersectsPen({ x: 49, y: 100 }, { x: 49, y: 200 }, stroke, 48)
    ).toBe(false);
    expect(
      eraserIntersectsPen(
        { x: 20, y: 20 },
        { x: 20, y: 20 },
        [
          { x: 20, y: 20 },
          { x: 20, y: 20 },
        ],
        48
      )
    ).toBe(true);
  });
  it('preserves unselected highlight portions and toggles only fully covered selections', () => {
    const line = { height: 20, width: 400, x: 100, y: 100 };
    const cut = { height: 20, width: 100, x: 200, y: 100 };
    expect(eraseRects([line], [cut])).toEqual([
      { height: 20, width: 100, x: 100, y: 100 },
      { height: 20, width: 200, x: 300, y: 100 },
    ]);
    expect(fullyHighlighted([cut], [line])).toBe(true);
    expect(fullyHighlighted([line], [cut])).toBe(false);
  });
  it('round trips page rotation', () => {
    const rect = { height: 40, width: 130, x: 10, y: 20 };
    for (const angle of [0, 90, 180, 270])
      expect(rotateRect(rotateRect(rect, angle), -angle)).toEqual(rect);
  });
  it('sweeps a circular eraser through nearby marks with rounded corners', () => {
    const mark = { height: 20, width: 20, x: 100, y: 100 };
    expect(
      eraserIntersectsRect({ x: 0, y: 55 }, { x: 200, y: 55 }, mark, 48)
    ).toBe(true);
    expect(
      eraserIntersectsRect({ x: 0, y: 50 }, { x: 200, y: 50 }, mark, 48)
    ).toBe(false);
    expect(
      eraserIntersectsRect({ x: 66, y: 66 }, { x: 66, y: 66 }, mark, 48)
    ).toBe(false);
    expect(
      eraserIntersectsRect({ x: 67, y: 67 }, { x: 67, y: 67 }, mark, 48)
    ).toBe(true);
  });
});
it('erases marks crossed between pointer events without erasing off-path marks', async () => {
  const { segmentIntersectsRect } = await import('./pdfAnnotationGeometry');
  const mark = { height: 10, width: 10, x: 50, y: 50 };
  expect(segmentIntersectsRect({ x: 0, y: 55 }, { x: 100, y: 55 }, mark)).toBe(
    true
  );
  expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 100, y: 20 }, mark)).toBe(
    false
  );
});
