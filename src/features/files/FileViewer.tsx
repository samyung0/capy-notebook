import { lazy, type ReactNode, Suspense } from 'react';
import type { SourceFile } from '@/api/types';
import { Icon } from '@/components/ui';
import { ImageViewer } from '@/features/files/ImageViewer';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import { FileEmpty, FileLoading } from '../materials/CenterContent';
import { fileExt, IMAGE_MIN_ZOOM, isImageFile } from './fileUtils';

const PdfView = lazy(() => import('./PdfView'));
const SheetView = lazy(() => import('./SheetView'));
const DocxView = lazy(() => import('./DocxView'));

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
const SHEET_EXTS = new Set(['xlsx', 'xls', 'csv']);

function lazyView(node: ReactNode) {
  return <Suspense fallback={<FileLoading />}>{node}</Suspense>;
}

function UnsupportedPreview({ file }: { file: SourceFile }) {
  const ext = fileExt(file.name);
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <Icon name="files" size={32} />
        <p className="t-subtitle">Preview not available</p>
        <p className="t-meta text-fg-muted">
          {ext ? `.${ext}` : 'This'} files can't be previewed yet.
          {file.url ? ' You can still download the original file.' : ''}
        </p>
        {file.url && (
          <a
            className="t-meta font-medium text-action underline underline-offset-2"
            download={file.name}
            href={file.url}
          >
            Download {file.name}
          </a>
        )}
      </div>
    </div>
  );
}

export function FileViewer({
  file,
  imageZoom = IMAGE_MIN_ZOOM,
  onImageZoomChange,
}: {
  file: SourceFile | null;
  imageZoom?: number;
  onImageZoomChange?: (next: number) => void;
}) {
  if (!file) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-2">
          <Icon name="files" size={32} />
          <p>Select a file to read it here.</p>
        </div>
      </div>
    );
  }

  const ext = fileExt(file.name);

  if (file.kind === 'pdf' || ext === 'pdf') {
    if (!file.url) return <FileEmpty />;
    return lazyView(<PdfView url={file.url} />);
  }

  if (isImageFile(file)) {
    if (!file.url) return <FileEmpty />;
    return (
      <ImageViewer
        alt={file.name}
        onZoomChange={onImageZoomChange}
        url={file.url}
        zoom={imageZoom}
      />
    );
  }

  if (file.kind === 'video' || VIDEO_EXTS.has(ext)) {
    if (!file.url) return <FileEmpty />;
    return (
      <div className="grid h-full w-full place-items-center p-6">
        <video
          className="mx-auto max-h-full max-w-full rounded-card bg-black"
          controls
          src={file.url}
        >
          Your browser can't play this video.
        </video>
      </div>
    );
  }

  if (file.kind === 'audio' || AUDIO_EXTS.has(ext)) {
    if (!file.url) return <FileEmpty />;
    return (
      <div className="grid h-full place-items-center">
        <div className="flex w-full max-w-140 flex-col items-center gap-3">
          <p className="t-subtitle">{file.name}</p>
          <audio className="w-full" controls src={file.url} />
        </div>
      </div>
    );
  }

  if (file.kind === 'sheet' || SHEET_EXTS.has(ext)) {
    if (!file.url) return <FileEmpty />;
    return lazyView(<SheetView url={file.url} />);
  }

  // docx renders in the browser; legacy binary .doc has no web viewer.
  if (ext === 'docx') {
    if (!file.url) return <FileEmpty />;
    return lazyView(<DocxView url={file.url} />);
  }

  // Markdown — render with the static Plate preview. `!= null` so empty
  // markdown files still preview instead of falling to "unsupported".
  if (file.kind === 'md') {
    if (file.content == null) return <FileEmpty />;
    return (
      <MaterialPreview className="mx-auto max-w-175" content={file.content} />
    );
  }

  // Plain text (or extracted text content from other kinds).
  if ((file.kind === 'txt' || file.content) && file.content != null) {
    return (
      <article className="mx-auto max-w-175 whitespace-pre-wrap p-6 text-[0.95rem] text-fg leading-relaxed">
        {file.content}
      </article>
    );
  }

  return <UnsupportedPreview file={file} />;
}
