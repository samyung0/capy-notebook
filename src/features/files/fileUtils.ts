import type { SourceFile } from '@/api/types';
import { m } from '@/i18n';

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
  'tif',
  'tiff',
  'heic',
  'heif',
  'ico',
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

/** DOCX, XLSX and PPTX open in the Office runtime under the two-row header. */
export const SHEET_EXTS = new Set(['csv', 'tsv']);
export const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'mdx',
  'mdc',
  'json',
]);

/** A file edited as text (SourceTextView): CSV and TSV, Markdown, plain
 * text and JSON. Its saved edits are its text. */
export function isSourceText(file: Pick<SourceFile, 'kind' | 'name'>) {
  const ext = fileExt(file.name);
  return (
    ext === 'csv' ||
    ext === 'tsv' ||
    file.kind === 'md' ||
    file.kind === 'txt' ||
    file.kind === 'json' ||
    TEXT_EXTS.has(ext)
  );
}

export function officeFormatOf(
  file: Pick<SourceFile, 'name'>
): 'docx' | 'xlsx' | 'pptx' | null {
  const ext = fileExt(file.name);
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx' ? ext : null;
}

export function isImageFile(file: Pick<SourceFile, 'kind' | 'name'>) {
  return file.kind === 'image' || IMAGE_EXTS.has(fileExt(file.name));
}

/** True while ingest is waiting for a parser slot or actively running. */
export function fileIsIngesting(status?: string) {
  return status === 'pending' || status === 'processing';
}

/** An audio file being processed: its transcription task is running (or about
 * to be), which the provider bills whatever happens, so the server refuses to
 * trash it (`audio_transcribing`) until its job ends. */
export function fileIsTranscribing(file: { kind: string; status?: string }) {
  return file.kind === 'audio' && file.status === 'processing';
}

/** Whether Clone is offered on a file (the workspace's canClone aside): a
 * processed file, or a partial one (failed but still indexed, a part
 * missing), which copies as partial so its new owner can retry it (parts
 * design Q2). The server copies no other file. */
export function fileCanClone(file: Pick<SourceFile, 'status' | 'indexed'>) {
  return file.status === 'ready' || (file.status === 'failed' && file.indexed);
}

/** Whether Move to… (another workspace or chapter) is offered on a workspace
 * file: its workspace's owner or its payer moves it; other editors keep the
 * chapter-only Move (Epo 2026-10-27). */
export function fileCanMoveTo(
  file: Pick<SourceFile, 'isPayer'>,
  workspace: { isOwner: boolean } | undefined
) {
  return file.isPayer || !!workspace?.isOwner;
}

/** Why a ready file is not searchable: its content is over an ingest limit,
 * a recording has no speech, or it was stored without processing. */
export function notIndexedMessage(file: Pick<SourceFile, 'indexLimit'>) {
  if (file.indexLimit === 'element_limit') {
    return m.files_not_indexed_too_many_elements();
  }
  if (file.indexLimit === 'no_speech') {
    return m.files_not_indexed_no_speech();
  }
  return file.indexLimit
    ? m.files_not_indexed_too_large()
    : m.files_not_indexed();
}
