import { lazy, type ReactNode, Suspense } from 'react';
import type { SourceFile } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Icon } from '@/components/ui/Icon';
import { ImageViewer } from '@/features/files/ImageViewer';
import { m } from '@/i18n';
import { FileEmpty, FileLoading } from './FileStates';
import { fileExt, IMAGE_MIN_ZOOM, isImageFile } from './fileUtils';

const PdfView = lazy(() => import('./PdfView'));
const SheetView = lazy(() => import('./SheetView'));
const DocxView = lazy(() => import('./DocxView'));
const TextView = lazy(() => import('./TextView'));
const PptxView = lazy(() => import('./PptxView'));

const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
const SHEET_EXTS = new Set(['xlsx', 'xls', 'csv']);
const SLIDE_EXTS = new Set(['ppt', 'pptx']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'mdx', 'mdc', 'json']);

function lazyView(node: ReactNode) {
  return <Suspense fallback={<FileLoading />}>{node}</Suspense>;
}

function UnsupportedPreview({ file }: { file: SourceFile }) {
  const ext = fileExt(file.name);
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <Icon name="files" size={32} />
        <p className="t-subtitle">{m.files_preview_unavailable()}</p>
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

interface FileViewerProps {
  file: SourceFile | null;
  imageZoom?: number;
  onImageZoomChange?: (next: number) => void;
  /** 1-based page to scroll to, from a chat citation. PDFs only. */
  page?: number;
}

export function FileViewer(props: FileViewerProps) {
  return (
    <AppErrorBoundary resetKeys={[props.file?.id]}>
      <FileViewerContent {...props} />
    </AppErrorBoundary>
  );
}

function FileViewerContent({
  file,
  imageZoom = IMAGE_MIN_ZOOM,
  onImageZoomChange,
  page,
}: FileViewerProps) {
  if (!file) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-2">
          <Icon name="files" size={32} />
          <p>{m.files_select_to_read()}</p>
        </div>
      </div>
    );
  }

  const ext = fileExt(file.name);

  if (file.kind === 'pdf' || ext === 'pdf') {
    if (!file.url) return <FileEmpty />;
    return lazyView(<PdfView page={page} url={file.url} />);
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

  if (file.kind === 'slides' || SLIDE_EXTS.has(ext)) {
    if (!file.url) return <FileEmpty />;
    return lazyView(<PptxView url={file.url} />);
  }

  const isMarkdown = file.kind === 'md' || ext === 'md' || ext === 'markdown';
  const isText =
    isMarkdown ||
    file.kind === 'txt' ||
    file.kind === 'json' ||
    TEXT_EXTS.has(ext);
  if (isText) {
    if (file.content == null && !file.url) return <FileEmpty />;
    return lazyView(
      <TextView content={file.content} markdown={isMarkdown} url={file.url} />
    );
  }

  return <UnsupportedPreview file={file} />;
}
