import type { OfficeRenderedPage } from './officeProtocol';

/* Pictures as PDF pages, so the PDF viewer's marks work on what is no PDF
   (Epo 2026-11-25, mock B6H1Z7o4byVFBVyCRSUK3B): a submitted photo as a page
   its own size (T2), a Word submission as the Office viewer draws its pages
   (C1). */

/** One page: an RGB JPEG `pixels` across, on a page `points` across. */
interface JpegPage {
  jpeg: Uint8Array;
  pixels: { height: number; width: number };
  points: { height: number; width: number };
}

/** The longer side a Word page's picture keeps: sharp at about 1.5× a page's
 * width on screen, about 200 KB a page, so a 100-page essay stays well inside
 * `SUBMISSION_COPY_MAX`. */
const OFFICE_PAGE_EDGE = 1600;

/** The longer side a photo's picture keeps: under iOS Safari's 16.7M-pixel
 * canvas, which a 24 MP phone photo is over. The page keeps the photo's size. */
const PHOTO_EDGE = 4000;

/** A photo as one page, one point a pixel. Drawn each time it opens; only the
 * marks are stored. */
export async function photoPagePdf(photo: Blob): Promise<Blob> {
  const url = URL.createObjectURL(photo);
  try {
    // An <img> decodes what the browser shows (SVG too) and turns a phone
    // photo upright from its EXIF orientation as it draws.
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = { height: img.naturalHeight, width: img.naturalWidth };
    const pixels = fitEdge(size, PHOTO_EDGE);
    return jpegPagesPdf([
      { jpeg: await jpegOf(img, pixels), pixels, points: size },
    ]);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The Office viewer's print pages (PNG, their size in CSS px) as a PDF of
 * the same page sizes, each picture at most OFFICE_PAGE_EDGE px. One page
 * decoded at a time: a long document never holds every bitmap. */
export async function officePagesPdf(
  pages: readonly OfficeRenderedPage[]
): Promise<Blob> {
  const out: JpegPage[] = [];
  for (const page of pages) {
    const bitmap = await createImageBitmap(
      new Blob([page.bytes], { type: 'image/png' })
    );
    try {
      const pixels = fitEdge(bitmap, OFFICE_PAGE_EDGE);
      out.push({
        jpeg: await jpegOf(bitmap, pixels),
        pixels,
        // CSS px to points: 96 to 72 an inch.
        points: { height: page.height * 0.75, width: page.width * 0.75 },
      });
    } finally {
      bitmap.close();
    }
  }
  return jpegPagesPdf(out);
}

/** `size` scaled down to at most `edge` on its longer side. */
function fitEdge(size: { height: number; width: number }, edge: number) {
  const scale = Math.min(1, edge / Math.max(size.width, size.height));
  return {
    height: Math.round(size.height * scale),
    width: Math.round(size.width * scale),
  };
}

/** `source` drawn at `size` on white (JPEG has no transparency). */
async function jpegOf(
  source: CanvasImageSource,
  size: { height: number; width: number }
) {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (jpeg) => (jpeg ? resolve(jpeg) : reject(new Error('No JPEG'))),
        'image/jpeg',
        0.85
      )
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // Frees the bitmap now rather than at the next collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** A PDF of `pages` in order, each its JPEG filling the page. */
export function jpegPagesPdf(pages: readonly JpegPage[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    parts.push(bytes);
    length += bytes.length;
  };
  // Objects 1 and 2 are the catalog and the page tree; page i (from 0) is
  // 3 + 3i, its picture 4 + 3i and its drawing 5 + 3i.
  const open = () => {
    offsets.push(length);
    return `${offsets.length} 0 obj\n`;
  };
  push('%PDF-1.4\n');
  push(`${open()}<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  push(
    `${open()}<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`
  );
  pages.forEach(({ jpeg, pixels, points }, i) => {
    const page = 3 + 3 * i;
    const { width, height } = points;
    push(
      `${open()}<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>\nendobj\n`
    );
    push(
      `${open()}<< /Type /XObject /Subtype /Image /Width ${pixels.width} /Height ${pixels.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    );
    push(jpeg);
    push('\nendstream\nendobj\n');
    const draw = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
    push(
      `${open()}<< /Length ${draw.length} >>\nstream\n${draw}\nendstream\nendobj\n`
    );
  });
  const xref = length;
  const entries = offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  push(
    `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  );
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}
