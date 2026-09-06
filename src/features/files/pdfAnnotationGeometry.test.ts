import { describe, expect, it } from 'vitest';
import {
  eraseRects,
  fullyHighlighted,
  rotateRect,
  toolbarPosition,
} from './pdfAnnotationGeometry';

describe('private PDF geometry', () => {
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
  it('round trips rotation and keeps floating controls inside the viewport', () => {
    const rect = { height: 40, width: 130, x: 10, y: 20 };
    for (const angle of [0, 90, 180, 270])
      expect(rotateRect(rotateRect(rect, angle), -angle)).toEqual(rect);
    expect(
      toolbarPosition(
        { x: 490, y: 490 },
        { bottom: 500, left: 0, right: 500, top: 0 },
        200,
        40
      )
    ).toEqual({ left: 292, top: 438 });
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
