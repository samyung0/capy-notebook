import { describe, expect, it } from 'vitest';
import { fitSize, hasAlpha, isAnimatedGif, shrinkPlan } from './fitImage';

// One graphic control extension followed by an image descriptor.
const frame = [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c];
const gif = (frames: number) =>
  new Uint8Array([
    ...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    ...Array.from({ length: frames }, () => [...frame, 0x01, 0x02]).flat(),
    0x3b,
  ]);

describe('shrinkPlan', () => {
  const max = 2 * 1024 * 1024;
  const over = max + 1;
  it('uploads an image within the cap as is, even animated', () => {
    expect(shrinkPlan({ size: max, type: 'image/gif' }, true, max)).toBe(
      'upload'
    );
  });
  it('shrinks a larger raster image', () => {
    expect(shrinkPlan({ size: over, type: 'image/png' }, false, max)).toBe(
      'shrink'
    );
    expect(shrinkPlan({ size: over, type: 'image/gif' }, false, max)).toBe(
      'shrink'
    );
  });
  it('refuses a larger animated GIF or SVG', () => {
    expect(shrinkPlan({ size: over, type: 'image/gif' }, true, max)).toBe(
      'too_large'
    );
    expect(shrinkPlan({ size: over, type: 'image/svg+xml' }, false, max)).toBe(
      'too_large'
    );
  });
});

describe('fitSize', () => {
  it('caps the long side at 2000 px and keeps the ratio', () => {
    expect(fitSize(4000, 3000)).toEqual({ height: 1500, width: 2000 });
    expect(fitSize(1000, 5000)).toEqual({ height: 2000, width: 400 });
  });
  it('never upscales', () => {
    expect(fitSize(800, 600)).toEqual({ height: 600, width: 800 });
  });
});

describe('isAnimatedGif', () => {
  it('counts frames', () => {
    expect(isAnimatedGif(gif(1))).toBe(false);
    expect(isAnimatedGif(gif(3))).toBe(true);
  });
});

describe('hasAlpha', () => {
  it('finds any pixel that is not fully opaque', () => {
    expect(hasAlpha(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(
      false
    );
    expect(hasAlpha(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(
      true
    );
  });
});
