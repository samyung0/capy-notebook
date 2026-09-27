import { strToU8, zipSync } from 'fflate';
import type { MaterialValue } from '@/features/materials/document';
import { type ExportLabels, flattenStudyBlocks } from './content';
import { makeDocx } from './docx';
import {
  type ExportFormat,
  type ExportImage,
  type Figure,
  renderExport,
} from './render';

export interface ExportRequest {
  assetUrls: Record<string, string>;
  format: ExportFormat;
  labels: ExportLabels;
  noteUrl: string;
  type: 'export';
  value: MaterialValue;
}
export interface ExportResult {
  blob: Blob;
  extension: 'md' | 'docx' | 'zip';
}
export type WorkerResponse =
  | { type: 'done'; result: ExportResult }
  | { type: 'error'; message: string }
  | { type: 'figure'; id: number; figure: Figure };
export type FigureResponse = {
  type: 'figure';
  id: number;
  image?: ExportImage;
  error?: string;
};
const pending = new Map<
  number,
  { resolve: (image: ExportImage) => void; reject: (error: Error) => void }
>();
let nextId = 0;
function hostFigure(figure: Figure): Promise<ExportImage> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { reject, resolve });
    self.postMessage({ figure, id, type: 'figure' } satisfies WorkerResponse);
  });
}

async function renderFigure(figure: Figure): Promise<ExportImage> {
  if (figure.type === 'math') {
    const { default: katex } = await import('katex');
    return hostFigure({
      ...figure,
      html: katex.renderToString(figure.tex, {
        displayMode: figure.display,
        macros: { '\\placeholder': '\\square' },
        throwOnError: true,
        trust: false,
      }),
    });
  }
  if (figure.type !== 'image' && figure.type !== 'youtube')
    return hostFigure(figure);
  const source =
    figure.type === 'youtube'
      ? `https://i.ytimg.com/vi/${figure.videoId}/hqdefault.jpg`
      : figure.source;
  if (source.startsWith('data:image/svg+xml'))
    return hostFigure({ source, type: 'image' });
  const response = await fetch(source);
  if (!response.ok)
    throw new Error(`Image download failed (${response.status}).`);
  const blob = await response.blob();
  if (blob.type.includes('svg'))
    return hostFigure({
      source: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await blob.text())}`,
      type: 'image',
    });
  const bitmap = await createImageBitmap(blob);
  try {
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height =
      figure.type === 'youtube'
        ? Math.round((width * 9) / 16)
        : Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image conversion is unavailable.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    if (figure.type === 'youtube') {
      const crop = (bitmap.width * 9) / 16;
      context.drawImage(
        bitmap,
        0,
        (bitmap.height - crop) / 2,
        bitmap.width,
        crop,
        0,
        0,
        width,
        height
      );
      context.fillStyle = '#cc0000';
      context.beginPath();
      context.roundRect(width / 2 - 34, height / 2 - 24, 68, 48, 12);
      context.fill();
      context.fillStyle = '#ffffff';
      context.beginPath();
      context.moveTo(width / 2 - 7, height / 2 - 12);
      context.lineTo(width / 2 + 14, height / 2);
      context.lineTo(width / 2 - 7, height / 2 + 12);
      context.fill();
    } else context.drawImage(bitmap, 0, 0, width, height);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await png.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { data: `data:image/png;base64,${btoa(binary)}`, height, width };
  } finally {
    bitmap.close();
  }
}

self.onmessage = async (
  event: MessageEvent<ExportRequest | FigureResponse>
) => {
  const request = event.data;
  if (request.type === 'figure') {
    const task = pending.get(request.id);
    pending.delete(request.id);
    if (request.image) task?.resolve(request.image);
    else task?.reject(new Error(request.error));
    return;
  }
  try {
    const value = flattenStudyBlocks(request.value, request.labels);
    const { content, files, toc } = await renderExport(
      value,
      request.format,
      request.labels,
      request.assetUrls,
      request.noteUrl,
      renderFigure
    );
    let result: ExportResult;
    if (request.format === 'docx')
      result = { blob: await makeDocx(content, toc), extension: 'docx' };
    else if (Object.keys(files).length) {
      files['document.md'] = strToU8(content);
      result = {
        blob: new Blob(
          [zipSync(files, { level: 1 }) as Uint8Array<ArrayBuffer>],
          { type: 'application/zip' }
        ),
        extension: 'zip',
      };
    } else
      result = {
        blob: new Blob([content], { type: 'text/markdown;charset=utf-8' }),
        extension: 'md',
      };
    self.postMessage({ result, type: 'done' } satisfies WorkerResponse);
  } catch (error) {
    self.postMessage({
      message:
        error instanceof Error ? error.message : 'Document export failed.',
      type: 'error',
    } satisfies WorkerResponse);
  }
};
