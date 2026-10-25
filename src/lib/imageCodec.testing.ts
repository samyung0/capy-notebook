import { vi } from 'vitest';

/** How a fake image's pixels read: a photo (many colours), a flat graphic
 * (two colours) or a transparent image. */
export type Look = 'photo' | 'flat' | 'alpha';

const SIGNATURES: Record<string, number[]> = {
  'image/bmp': [0x42, 0x4d],
  'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

const FAKE = /fake:(\d+)x(\d+):(\w+)/;

/** Bytes the fake decoder reads: the type's signature, then its size and
 * look, padded to `size`. */
export function fakeImage(
  type: string,
  width: number,
  height: number,
  look: Look = 'photo',
  size = 1000
) {
  const head = [
    ...SIGNATURES[type],
    ...new TextEncoder().encode(` fake:${width}x${height}:${look} `),
  ];
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head);
  return bytes;
}

/** Stubs createImageBitmap and OffscreenCanvas with a decoder that reads
 * fakeImage bytes and an encoder whose output size `encoded` decides. Each
 * encode is logged as "type WxH quality". */
export function stubImageCodec() {
  const codec = {
    encoded: (_type: string, _width: number, _quality?: number) => 100_000,
    encodes: [] as string[],
    webp: true,
  };
  vi.stubGlobal(
    'ImageData',
    class {
      readonly data: Uint8ClampedArray;
      readonly height: number;
      readonly width: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.height = height;
        this.width = width;
      }
    }
  );
  vi.stubGlobal('createImageBitmap', async (blob: Blob | ImageData) => {
    // Pixels a decoder of the app's own produced read as a photo.
    if (!(blob instanceof Blob))
      return {
        close() {},
        height: blob.height,
        look: 'photo',
        width: blob.width,
      };
    const text = new TextDecoder().decode(
      new Uint8Array(await blob.arrayBuffer()).subarray(0, 64)
    );
    const match = FAKE.exec(text);
    if (!match) throw new Error('undecodable');
    return {
      close() {},
      height: Number(match[2]),
      look: match[3] as Look,
      width: Number(match[1]),
    };
  });
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      look: Look = 'photo';
      readonly height: number;
      readonly width: number;
      constructor(width: number, height: number) {
        this.height = height;
        this.width = width;
      }
      getContext() {
        return {
          drawImage: (image: { look: Look }) => {
            this.look = image.look;
          },
          getImageData: () => ({
            data: new Uint8ClampedArray(
              {
                alpha: [9, 9, 9, 0],
                flat: [0, 0, 0, 255, 255, 255, 255, 255],
                photo: Array.from({ length: 300 }, (_, i) => [
                  i & 255,
                  i >> 8,
                  7,
                  255,
                ]).flat(),
              }[this.look]
            ),
          }),
        };
      }
      async convertToBlob({
        quality,
        type,
      }: {
        quality?: number;
        type: string;
      }) {
        const encoded =
          type === 'image/webp' && !codec.webp ? 'image/png' : type;
        codec.encodes.push(
          `${encoded} ${this.width}x${this.height} ${quality ?? ''}`.trim()
        );
        return new Blob(
          [
            fakeImage(
              encoded,
              this.width,
              this.height,
              this.look,
              codec.encoded(encoded, this.width, quality)
            ),
          ],
          { type: encoded }
        );
      }
    }
  );
  return codec;
}
