import { m } from '@/i18n';

/** The long side of a page sent to a run, as the server renders a PDF page. */
const PAGE_EDGE = 1568;
/** Go takes a drawn page of at most 1 MiB. */
const PAGE_BYTES = 1 << 20;
const QUALITIES = [0.8, 0.6, 0.4];

export interface DrawnPage {
  height: number;
  jpegBase64: string;
  url: string;
  width: number;
}

async function base64Of(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x80_00)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x80_00));
  return btoa(text);
}

/** A page the Office runtime drew as a PNG, as the JPEG a run is sent: at most
 * PAGE_EDGE on its long side, at the best quality that fits Go's cap. */
export async function drawnPage(page: {
  bytes: ArrayBuffer;
}): Promise<DrawnPage> {
  const bitmap = await createImageBitmap(
    new Blob([page.bytes], { type: 'image/png' })
  );
  try {
    const scale = Math.min(
      1,
      PAGE_EDGE / Math.max(bitmap.width, bitmap.height)
    );
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error(m.make_quiz_pages_unavailable());
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of QUALITIES) {
      const blob = await canvas.convertToBlob({ quality, type: 'image/jpeg' });
      if (blob.size <= PAGE_BYTES) {
        const jpegBase64 = await base64Of(blob);
        return {
          height,
          jpegBase64,
          url: `data:image/jpeg;base64,${jpegBase64}`,
          width,
        };
      }
    }
    throw new Error(m.make_quiz_pages_unavailable());
  } finally {
    bitmap.close();
  }
}
