import { describe, expect, it } from 'vitest';
import { PptxImageCache } from './pptxImageCache';

describe('PptxImageCache', () => {
  it('keeps the most recently used entries and releases evictions', async () => {
    const first = {} as CanvasImageSource;
    const second = {} as CanvasImageSource;
    const third = {} as CanvasImageSource;
    const released: CanvasImageSource[] = [];
    const cache = new PptxImageCache(2, (source) => released.push(source));
    const firstImage = Promise.resolve(first);
    const secondImage = Promise.resolve(second);
    const thirdImage = Promise.resolve(third);

    cache.set('first', firstImage);
    cache.set('second', secondImage);
    expect(cache.get('first')).toBe(firstImage);
    cache.set('third', thirdImage);

    await Promise.all([firstImage, secondImage, thirdImage]);
    expect(cache.size).toBe(2);
    expect(cache.get('first')).toBe(firstImage);
    expect(cache.get('second')).toBeUndefined();
    expect(released).toEqual([second]);
  });
});
