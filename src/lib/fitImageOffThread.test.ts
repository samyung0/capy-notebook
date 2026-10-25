import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { CopyError } from './copyError';
import type { FitRequest } from './fitImageOffThread';
import { fitImageOffThread } from './fitImageOffThread';
import { stubImageCodec, stubSvgImage } from './imageCodec.testing';

let posted: FitRequest[];
beforeEach(() => {
  stubImageCodec();
  stubSvgImage();
  posted = [];
  // The compression worker answers with the file it was given.
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      postMessage(data: FitRequest) {
        posted.push(data);
        queueMicrotask(() => this.onmessage?.({ data: { file: data.file } }));
      }
      terminate() {}
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Review r4 N4: a note, quiz, flashcard or bank image that is an SVG reaches
// the compressor as a PNG it keeps PNG (Q364).
describe('fitImageOffThread', () => {
  it('draws an SVG image as a PNG on the page before the worker', async () => {
    const file = await fitImageOffThread(
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"></svg>',
        ],
        'diagram.svg',
        { type: 'image/svg+xml' }
      ),
      2 << 20
    );
    expect(posted).toHaveLength(1);
    expect(posted[0].png).toBe(true);
    expect(file.name).toBe('diagram.png');
    expect(file.type).toBe('image/png');
  });

  it('refuses an SVG that does not load with the unreadable copy, and sends other images as they are', async () => {
    await expect(
      fitImageOffThread(
        new File(['<svg xmlns="http://www.w3.org/2000/svg"'], 'broken.svg'),
        2 << 20
      )
    ).rejects.toEqual(new CopyError(m.image_unreadable()));
    expect(posted).toHaveLength(0);
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', {
      type: 'image/jpeg',
    });
    expect(await fitImageOffThread(photo, 2 << 20)).toBe(photo);
    expect(posted[0].png).toBe(false);
  });
});
