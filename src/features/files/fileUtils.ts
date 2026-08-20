import type { SourceFile } from '@/api/types';

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'jp2',
  'webp',
  'gif',
  'bmp',
  'svg',
  'avif',
]);

export const IMAGE_MIN_ZOOM = 1;
export const IMAGE_MAX_ZOOM = 5;
export const IMAGE_ZOOM_STEP = 0.25;

export function clampImageZoom(next: number) {
  return Math.min(
    IMAGE_MAX_ZOOM,
    Math.max(IMAGE_MIN_ZOOM, Math.round(next * 100) / 100)
  );
}

export function fileExt(name: string) {
  return name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function isImageFile(file: Pick<SourceFile, 'kind' | 'name'>) {
  return file.kind === 'image' || IMAGE_EXTS.has(fileExt(file.name));
}

/** True while ingest is waiting for a worker/GPU slot or actively running. */
export function fileIsIngesting(status?: string) {
  return status === 'pending' || status === 'processing';
}
