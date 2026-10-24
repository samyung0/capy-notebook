import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeUncommon } from './decodeImage';
import { fitImage, ImageUnreadableError } from './fitImage';
import { stubImageCodec } from './imageCodec.testing';

// Node cannot fetch the asset URL the app imports libheif from; hand it the
// package's file instead.
vi.mock('libheif-js/libheif-wasm/libheif-bundle.mjs?url', () => ({
  default: new URL(
    '../../node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs',
    import.meta.url
  ).href,
}));

const fixtures = new URL('../../e2e/fixtures/files/images/', import.meta.url);
const fixture = (name: string) =>
  new File([readFileSync(new URL(name, fixtures))], name);
const manifest = JSON.parse(
  readFileSync(new URL('manifest.json', fixtures), 'utf8')
) as {
  source: Record<string, [string, number, number]>;
  unreadable: string[];
};

describe('decodeUncommon', () => {
  it.each(['photo.heic', 'photo.tif', 'photo.jp2'])(
    'decodes %s to RGBA',
    async (name) => {
      const pixels = await decodeUncommon(fixture(name));
      expect(pixels).toMatchObject({ height: 2000, width: 3000 });
      expect(pixels?.data.length).toBe(3000 * 2000 * 4);
    },
    60_000
  );

  it('rejects a corrupt HEIC and passes over a file the browser reads', async () => {
    await expect(decodeUncommon(fixture('corrupt.heic'))).rejects.toThrow();
    expect(await decodeUncommon(fixture('photo.jpg'))).toBeNull();
  });
});

describe('fitImage for a source', () => {
  let codec: ReturnType<typeof stubImageCodec>;
  beforeEach(() => {
    codec = stubImageCodec();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['photo.heic', 'photo.tif', 'photo.jp2'])(
    'shrinks %s to at most 5 megapixels as the manifest says',
    async (name) => {
      const [format, width, height] = manifest.source[name];
      const result = await fitImage(fixture(name), 30 << 20, {
        maxPixels: 5_000_000,
      });
      expect(result.type).toBe(`image/${format}`);
      expect(codec.encodes).toEqual([
        `image/${format} ${width}x${height} 0.85`,
      ]);
      expect(width * height).toBeLessThanOrEqual(5_000_000);
    },
    60_000
  );

  it('refuses a file no decoder reads', async () => {
    for (const name of manifest.unreadable)
      await expect(
        fitImage(fixture(name), 30 << 20, { maxPixels: 5_000_000 })
      ).rejects.toThrow(ImageUnreadableError);
  });
});
