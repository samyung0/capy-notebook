// The decoders for image files the browser cannot read itself (Epo 2026-10-24,
// Q294), each loaded only when such a file is picked, never in the main
// bundle: libheif for HEIC and HEIF (LGPL-3.0, so its prebuilt module ships
// as its own unmodified file, fetched at runtime; THIRD-PARTY-NOTICES.md),
// UTIF for TIFF and pdf.js's OpenJPEG build for JPEG 2000.

export interface Pixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  height: number;
  width: number;
}

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

/** Which decoder a file needs, by signature, or null for one the browser
 * reads (or nothing can). */
export function uncommonFormat(bytes: Uint8Array) {
  const text = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (text(4, 8) === 'ftyp' && HEIF_BRANDS.has(text(8, 12))) return 'heif';
  if (text(0, 4) === 'II*\0' || text(0, 4) === 'MM\0*') return 'tiff';
  if (text(4, 8) === 'jP  ' || text(0, 4) === '\xff\x4f\xff\x51') return 'jp2';
  return null;
}

type HeifImage = {
  display(
    target: { data: Uint8ClampedArray; height: number; width: number },
    done: (result: unknown) => void
  ): void;
  free(): void;
  get_height(): number;
  get_width(): number;
};
type Libheif = {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
};

async function heif(bytes: Uint8Array): Promise<Pixels> {
  const { default: url } = await import(
    'libheif-js/libheif-wasm/libheif-bundle.mjs?url'
  );
  const { default: factory } = (await import(/* @vite-ignore */ url)) as {
    default: () => Libheif | Promise<Libheif>;
  };
  const libheif = await factory();
  const [image] = new libheif.HeifDecoder().decode(bytes);
  if (!image) throw new Error('no image in the HEIF file');
  try {
    const width = image.get_width();
    const height = image.get_height();
    const data = new Uint8ClampedArray(width * height * 4);
    await new Promise<void>((resolve, reject) =>
      image.display({ data, height, width }, (result) =>
        result ? resolve() : reject(new Error('the HEIF image did not decode'))
      )
    );
    return { data, height, width };
  } finally {
    image.free();
  }
}

async function tiff(bytes: Uint8Array): Promise<Pixels> {
  const { default: UTIF } = await import('utif2');
  const buffer = bytes.slice().buffer;
  const [page] = UTIF.decode(buffer);
  if (!page) throw new Error('no image in the TIFF file');
  UTIF.decodeImage(buffer, page);
  return {
    data: new Uint8ClampedArray(UTIF.toRGBA8(page)),
    height: page.height,
    width: page.width,
  };
}

async function jp2(bytes: Uint8Array): Promise<Pixels> {
  const { JpxImage } = await import(
    'pdfjs-dist/image_decoders/pdf.image_decoders.mjs'
  );
  const { height, width } = JpxImage.parseImageProperties(bytes);
  // Gray, RGB or RGBA, as many components as the image holds.
  const decoded = JpxImage.decode(bytes, {});
  const components = decoded.length / (width * height);
  if (![1, 3, 4].includes(components))
    throw new Error('the JPEG 2000 image did not decode');
  if (components === 4) return { data: decoded, height, width };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++)
      data[pixel * 4 + channel] =
        decoded[pixel * components + (components === 3 ? channel : 0)];
    data[pixel * 4 + 3] = 255;
  }
  return { data, height, width };
}

/** The RGBA pixels of a HEIC/HEIF, TIFF or JPEG 2000 file; null for any
 * other file. Throws when the decoder rejects the file. */
export async function decodeUncommon(blob: Blob): Promise<Pixels | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const format = uncommonFormat(bytes);
  if (format === 'heif') return heif(bytes);
  if (format === 'tiff') return tiff(bytes);
  if (format === 'jp2') return jp2(bytes);
  return null;
}
