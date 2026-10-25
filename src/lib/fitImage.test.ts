import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fitArea,
  fitImage,
  fitSize,
  ImageTooLargeError,
  ImageTooManyPixelsError,
  ImageUnreadableError,
  isAnimatedGif,
  isSvgImage,
  pixelTraits,
} from './fitImage';
import { fakeImage, type Look, stubImageCodec } from './imageCodec.testing';

// One graphic control extension followed by an image descriptor.
const frame = [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c];
const gif = (frames: number) =>
  new Uint8Array([
    ...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    ...Array.from({ length: frames }, () => [...frame, 0x01, 0x02]).flat(),
    0x3b,
  ]);

const MB = 1024 * 1024;
let codec: ReturnType<typeof stubImageCodec>;
let encodes: string[];

function picked(
  name: string,
  type: string,
  size: number,
  width: number,
  height: number,
  look: Look = 'photo',
  tail: Uint8Array<ArrayBuffer> = new Uint8Array()
) {
  return new File([fakeImage(type, width, height, look, size), tail], name, {
    type,
  });
}

beforeEach(() => {
  codec = stubImageCodec();
  encodes = codec.encodes;
});
afterEach(() => vi.unstubAllGlobals());

describe('fitImage', () => {
  it('resizes an under-cap 6000x4000 JPEG to 2,400 px', async () => {
    const photo = picked('photo.jpg', 'image/jpeg', 1.5 * MB, 6000, 4000);
    const office = await fitImage(photo, 2 * MB, { office: true });
    expect(office.type).toBe('image/jpeg');
    expect(office.name).toBe('photo.jpg');
    expect(encodes).toEqual(['image/jpeg 2400x1600 0.85']);
    encodes.length = 0;
    const note = await fitImage(photo, 2 * MB);
    expect(note.type).toBe('image/webp');
    expect(encodes).toEqual(['image/webp 2400x1600 0.85']);
  });

  it('resizes an image whose short side rounds to the same width', async () => {
    // Review N1: 2x3000 fits as 2x2400, so the height decides.
    const strip = picked('strip.png', 'image/png', 5000, 2, 3000, 'flat');
    await fitImage(strip, 2 * MB, { office: true });
    expect(encodes).toEqual(['image/png 2x2400 0.85']);
  });

  it('keeps a small image byte-identical when its re-encode is not smaller', async () => {
    const small = picked('small.jpg', 'image/jpeg', 50_000, 800, 600);
    codec.encoded = () => 60_000;
    expect(await fitImage(small, 2 * MB, { office: true })).toBe(small);
    expect(await fitImage(small, 2 * MB)).toBe(small);
  });

  it('re-encodes a small image when the result is smaller, and every type an Office file cannot take', async () => {
    codec.encoded = () => 40_000;
    const small = picked('small.png', 'image/png', 50_000, 800, 600);
    expect((await fitImage(small, 2 * MB, { office: true })).name).toBe(
      'small.jpg'
    );
    // A WebP is never kept in an Office file, even when its JPEG is larger.
    codec.encoded = () => 90_000;
    const chart = picked('chart.webp', 'image/webp', 50_000, 600, 400);
    expect((await fitImage(chart, 2 * MB, { office: true })).type).toBe(
      'image/jpeg'
    );
    expect(await fitImage(chart, 2 * MB)).toBe(chart);
  });

  it('gives an Office file PNG for transparency and flat graphics, JPEG for photos', async () => {
    const cases: [Look, string][] = [
      ['alpha', 'image/png'],
      ['flat', 'image/png'],
      ['photo', 'image/jpeg'],
    ];
    for (const [look, type] of cases) {
      const image = picked('big.png', 'image/png', MB, 3000, 3000, look);
      expect((await fitImage(image, 2 * MB, { office: true })).type).toBe(type);
    }
    // A note takes WebP, and PNG or JPEG only without a WebP encoder.
    codec.webp = false;
    const alpha = picked('logo.png', 'image/png', MB, 3000, 3000, 'alpha');
    expect((await fitImage(alpha, 2 * MB)).type).toBe('image/png');
    const photo = picked('photo.png', 'image/png', MB, 3000, 3000, 'photo');
    expect((await fitImage(photo, 2 * MB)).type).toBe('image/jpeg');
  });

  it('shrinks a result over the cap: lossy at 2000 px with falling quality', async () => {
    const photo = picked('photo.jpg', 'image/jpeg', 8 * MB, 4000, 3000);
    codec.encoded = (_type, width, quality = 1) =>
      width > 2000 || quality > 0.7 ? 3 * MB : MB;
    await fitImage(photo, 2 * MB, { office: true });
    expect(encodes).toEqual([
      'image/jpeg 2400x1800 0.85',
      'image/jpeg 2000x1500 0.85',
      'image/jpeg 2000x1500 0.8',
      'image/jpeg 2000x1500 0.7',
    ]);
  });

  it('draws a transparent PNG over the cap at 2000, 1400 and 1000 px, then refuses it', async () => {
    const logo = picked('logo.png', 'image/png', 8 * MB, 3000, 3000, 'alpha');
    codec.encoded = (_type, width) => (width <= 1400 ? MB : 3 * MB);
    expect((await fitImage(logo, 2 * MB, { office: true })).type).toBe(
      'image/png'
    );
    expect(encodes).toEqual([
      'image/png 2400x2400 0.85',
      'image/png 2000x2000',
      'image/png 1400x1400',
    ]);
    codec.encoded = () => 3 * MB;
    await expect(fitImage(logo, 2 * MB, { office: true })).rejects.toThrow(
      ImageTooLargeError
    );
  });

  it('keeps an animated GIF within the side and the cap, and refuses it past either', async () => {
    const small = picked('spin.gif', 'image/gif', 0, 400, 300, 'flat', gif(3));
    expect(await fitImage(small, 2 * MB, { office: true })).toBe(small);
    const wide = picked('spin.gif', 'image/gif', 0, 3000, 300, 'flat', gif(3));
    await expect(fitImage(wide, 2 * MB)).rejects.toThrow(ImageTooLargeError);
    await expect(fitImage(small, 10)).rejects.toThrow(ImageTooLargeError);
    // A source past 5 megapixels: the pixels are the problem, not the bytes.
    const huge = picked('spin.gif', 'image/gif', 0, 3000, 2000, 'flat', gif(3));
    await expect(
      fitImage(huge, 30 * MB, { maxPixels: 5_000_000 })
    ).rejects.toThrow(ImageTooManyPixelsError);
  });

  it('shrinks a source image past 5 megapixels by area and keeps a smaller one as it is', async () => {
    const photo = picked('photo.png', 'image/png', 20 * MB, 4000, 3000);
    const shrunk = await fitImage(photo, 30 * MB, { maxPixels: 5_000_000 });
    expect(shrunk.name).toBe('photo.jpg');
    expect(encodes).toEqual(['image/jpeg 2581x1936 0.85']);
    expect(2581 * 1936).toBeLessThanOrEqual(5_000_000);
    const scan = picked('scan.png', 'image/png', 12 * MB, 2500, 2000);
    expect(await fitImage(scan, 30 * MB, { maxPixels: 5_000_000 })).toBe(scan);
  });

  it('re-saves a source the server does not keep even within 5 megapixels', async () => {
    // Q344: by its bytes, so a BMP named .png is re-saved too.
    for (const name of ['scan.bmp', 'scan.png']) {
      const scan = new File(
        [fakeImage('image/bmp', 2500, 2000, 'photo', 12 * MB)],
        name,
        { type: name.endsWith('.png') ? 'image/png' : 'image/bmp' }
      );
      const saved = await fitImage(scan, 30 * MB, { maxPixels: 5_000_000 });
      expect(saved.type).toBe('image/jpeg');
      expect(saved.name).toBe('scan.jpg');
    }
  });

  it('refuses an image it cannot decode', async () => {
    const tiff = new File([new Uint8Array(4)], 'scan.tiff', {
      type: 'image/tiff',
    });
    await expect(fitImage(tiff, 2 * MB, { office: true })).rejects.toThrow(
      ImageUnreadableError
    );
  });

  it('keeps an SVG drawn as a PNG a PNG, as a source past 5 MP and as a note image past the cap', async () => {
    // Review r4 N3 (Q364): never JPEG or WebP, however photo-like.
    const drawn = picked('logo.png', 'image/png', 3 * MB, 2400, 2400);
    const source = await fitImage(drawn, 30 * MB, {
      maxPixels: 5_000_000,
      png: true,
    });
    expect(source.type).toBe('image/png');
    expect(encodes).toEqual(['image/png 2236x2236 0.85']);
    encodes.length = 0;
    codec.encoded = (_type, width) => (width > 1400 ? 3 * MB : MB);
    const note = await fitImage(drawn, 2 * MB, { png: true });
    expect(note.name).toBe('logo.png');
    expect(encodes).toEqual([
      'image/png 2400x2400 0.85',
      'image/png 2000x2000',
      'image/png 1400x1400',
    ]);
  });
});

describe('SVG_ROOT', () => {
  it('answers at once on a run of comments and still finds real SVG roots within 4 KiB', () => {
    // Security regression (review r4 S2): under the old lazy comment, 24
    // empty comments split 2^23 ways (seconds on the main thread).
    const started = performance.now();
    expect(
      isSvgImage(new TextEncoder().encode(`${'<!---->'.repeat(24)}x`))
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    const head =
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n' +
      '<!-- Generator: Illustrator -- 24 -->\n<svg version="1.1">';
    expect(isSvgImage(new TextEncoder().encode(head))).toBe(true);
    expect(
      isSvgImage(new TextEncoder().encode(`${' '.repeat(4096)}<svg>`))
    ).toBe(false);
  });
});

describe('fitSize', () => {
  it('caps the long side and keeps the ratio', () => {
    expect(fitSize(6000, 4000, 2400)).toEqual({ height: 1600, width: 2400 });
    expect(fitSize(1000, 5000, 2400)).toEqual({ height: 2400, width: 480 });
  });
  it('never upscales', () => {
    expect(fitSize(800, 600, 2400)).toEqual({ height: 600, width: 800 });
  });
});

describe('fitArea', () => {
  it('rounds down so the area never passes the limit', () => {
    expect(fitArea(4032, 3024, 5_000_000)).toEqual({
      height: 1936,
      width: 2581,
    });
    expect(fitArea(2000, 2000, 5_000_000)).toEqual({
      height: 2000,
      width: 2000,
    });
  });
});

describe('isAnimatedGif', () => {
  it('counts frames', () => {
    expect(isAnimatedGif(gif(1))).toBe(false);
    expect(isAnimatedGif(gif(3))).toBe(true);
  });
});

describe('pixelTraits', () => {
  it('finds any pixel that is not fully opaque', () => {
    expect(
      pixelTraits(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254])).alpha
    ).toBe(true);
  });
  it('reads an opaque image of at most 256 colours as flat', () => {
    const colours = (count: number) =>
      new Uint8ClampedArray(
        Array.from({ length: count }, (_, i) => [
          i & 255,
          i >> 8,
          0,
          255,
        ]).flat()
      );
    expect(pixelTraits(colours(256))).toEqual({ alpha: false, flat: true });
    expect(pixelTraits(colours(257))).toEqual({ alpha: false, flat: false });
  });
});
