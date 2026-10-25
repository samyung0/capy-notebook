import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageUnreadableError } from './fitImage';
import { stubImageCodec, stubSvgImage } from './imageCodec.testing';
import { pngFromSvg, svgSize } from './svgImage';

const svg = (body: string) =>
  new File([body], 'logo.svg', { type: 'image/svg+xml' });

let codec: ReturnType<typeof stubImageCodec>;
let blobs: Map<string, Blob>;
beforeEach(() => {
  codec = stubImageCodec();
  blobs = stubSvgImage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Q364: a picked SVG image reaches the server as a PNG.
describe('pngFromSvg', () => {
  it('draws a sized SVG at its own size, as logo.png', async () => {
    const png = await pngFromSvg(
      svg(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"></svg>'
      )
    );
    expect(png?.name).toBe('logo.png');
    expect(png?.type).toBe('image/png');
    expect(codec.encodes).toEqual(['image/png 300x150']);
    // The blob URL is let go.
    expect(blobs.size).toBe(0);
  });

  it("draws a viewBox-only SVG at 2,400 px on its long side, keeping the viewBox's ratio, and refuses a viewBox that sizes nothing", async () => {
    await pngFromSvg(
      svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>'
      )
    );
    expect(codec.encodes).toEqual(['image/png 2400x1200']);
    // Review r4 N2: an infinite viewBox gives no size.
    await expect(
      pngFromSvg(
        svg(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 Infinity 1"></svg>'
        )
      )
    ).rejects.toBeInstanceOf(ImageUnreadableError);
  });

  it('refuses an SVG the canvas cannot encode as unreadable', async () => {
    // Review r4 N2: a tainted canvas throws on encode.
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage() {} };
        }
        convertToBlob() {
          return Promise.reject(new DOMException('tainted', 'SecurityError'));
        }
      }
    );
    await expect(
      pngFromSvg(
        svg(
          '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"></svg>'
        )
      )
    ).rejects.toBeInstanceOf(ImageUnreadableError);
  });

  it('refuses an SVG that does not load as unreadable, and passes over any other image', async () => {
    await expect(
      pngFromSvg(svg('<svg xmlns="http://www.w3.org/2000/svg" width="3"'))
    ).rejects.toBeInstanceOf(ImageUnreadableError);
    expect(
      await pngFromSvg(
        new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png')
      )
    ).toBeNull();
    expect(codec.encodes).toEqual([]);
  });
});

describe('svgSize', () => {
  it('keeps a large SVG within 2,400 px and finds the root past comments', () => {
    expect(
      svgSize(
        '<!-- <svg width="1" height="1"> --><svg width="6000" height="3000">',
        { height: 3000, width: 6000 }
      )
    ).toEqual({ height: 1200, width: 2400 });
  });

  it('sizes a percentage-sized SVG by its viewBox, and gives none without a size', () => {
    expect(
      svgSize('<svg width="100%" height="100%" viewBox="0,0,50,100">', {
        height: 150,
        width: 300,
      })
    ).toEqual({ height: 2400, width: 1200 });
    expect(svgSize('<svg>', { height: 0, width: 0 })).toBeNull();
  });
});
