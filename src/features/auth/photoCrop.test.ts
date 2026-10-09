import { describe, expect, it } from 'vitest';
import { circleCoverage, fitView, MIN_COVERAGE, minZoomFor } from './photoCrop';

const landscape = { height: 400, width: 800 };
const range = { max: 4, min: 0.5 };

describe('fitView', () => {
  it('keeps a cover-fit photo over the circle', () => {
    // At zoom 1 the 400 px side spans the 200 px circle: 400 px wide, 200 tall.
    expect(
      fitView({ rotation: 0, x: 500, y: 50, zoom: 1 }, landscape, 200, range)
    ).toEqual({ rotation: 0, x: 100, y: 0, zoom: 1 });
  });
  it('swaps the free axis after a quarter turn', () => {
    expect(
      fitView({ rotation: 90, x: 500, y: 500, zoom: 1 }, landscape, 200, range)
    ).toEqual({ rotation: 90, x: 0, y: 100, zoom: 1 });
  });
  it('bounds the zoom', () => {
    expect(
      fitView({ rotation: 0, x: 0, y: 0, zoom: 9 }, landscape, 200, range).zoom
    ).toBe(4);
    expect(
      fitView({ rotation: 0, x: 0, y: 0, zoom: 0.1 }, landscape, 200, range)
        .zoom
    ).toBe(0.5);
  });
});

describe('circleCoverage', () => {
  it('matches the known shapes', () => {
    expect(circleCoverage(1, 1, 1)).toBeCloseTo(1);
    // The inscribed square covers 2/pi.
    expect(circleCoverage(Math.SQRT1_2, Math.SQRT1_2, 1)).toBeCloseTo(
      2 / Math.PI
    );
    // A band through the middle as tall as the radius.
    const band = (Math.sqrt(3) / 2 + Math.PI / 3) / Math.PI;
    expect(circleCoverage(2, 0.5, 1)).toBeCloseTo(band);
  });
});

describe('minZoomFor', () => {
  it('zooms out until the photo covers MIN_COVERAGE of the circle', () => {
    for (const size of [landscape, { height: 300, width: 300 }]) {
      const zoom = minZoomFor(size);
      expect(zoom).toBeLessThan(1);
      const long = Math.max(size.width, size.height);
      const short = Math.min(size.width, size.height);
      expect(circleCoverage((zoom * long) / short, zoom, 1)).toBeCloseTo(
        MIN_COVERAGE,
        4
      );
    }
  });
});
