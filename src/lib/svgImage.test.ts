import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageUnreadableError } from './fitImage';
import { stubImageCodec } from './imageCodec.testing';
import { pngFromSvg, svgSize } from './svgImage';

const SIZE_ATTRIBUTE = /\s(width|height)="(\d+)"/g;

/** An <img> as the browser loads an SVG blob: it decodes when the bytes hold
 * an <svg> root with a closing tag, and its natural size is the root's
 * width and height in px (none for a viewBox-only SVG). */
function stubImage() {
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    blobs.delete(url);
  });
  vi.stubGlobal(
    'Image',
    class {
      look = 'flat';
      naturalHeight = 0;
      naturalWidth = 0;
      src = '';
      async decode() {
        const text = (await blobs.get(this.src)?.text()) ?? '';
        if (!(text.includes('<svg') && text.includes('</svg>')))
          throw new Error('broken');
        const size = Object.fromEntries(
          [...text.matchAll(SIZE_ATTRIBUTE)].map(([, name, value]) => [
            name,
            Number(value),
          ])
        );
        this.naturalWidth = size.width ?? 0;
        this.naturalHeight = size.height ?? 0;
      }
    }
  );
  return blobs;
}

const svg = (body: string) =>
  new File([body], 'logo.svg', { type: 'image/svg+xml' });

let codec: ReturnType<typeof stubImageCodec>;
let blobs: Map<string, Blob>;
beforeEach(() => {
  codec = stubImageCodec();
  blobs = stubImage();
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

  it("draws a viewBox-only SVG at 2,400 px on its long side, keeping the viewBox's ratio", async () => {
    await pngFromSvg(
      svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>'
      )
    );
    expect(codec.encodes).toEqual(['image/png 2400x1200']);
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
