import { lazy, type ReactNode, Suspense, useState } from 'react';
import { useWorkspace } from '@/api/hooks';
import type { Region, SourceFile } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ImageViewer } from '@/features/files/ImageViewer';
import { m } from '@/i18n';
import { FileEmpty, FileLoading } from './FileStates';
import { fileExt, IMAGE_MIN_ZOOM, isImageFile } from './fileUtils';
import { SourceTextView } from './SourceTextView';
import { officeRuntimeKey } from './useOfficeRuntime';

const PdfView = lazy(() => import('./PdfView'));
const SheetView = lazy(() => import('./SheetView'));
const CsvView = lazy(() => import('./CsvView'));
const DocxView = lazy(() => import('./DocxView'));
const TextView = lazy(() => import('./TextView'));
const PptxView = lazy(() => import('./PptxView'));

const AUDIO_EXTS = new Set([
  'mp3',
  'wav',
  'm4a',
  'ogg',
  'flac',
  'aac',
  'webm',
  'mp4',
  'mpeg',
  'mpga',
  'opus',
]);
const SHEET_EXTS = new Set(['csv', 'tsv', 'xlsx']);
const SLIDE_EXTS = new Set(['pptx']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'mdx', 'mdc', 'json']);
const OFFICE_PREVIEW_EXTS = new Set(['docx', 'pptx', 'xlsx']);

export function officeCitationPreviewUrl(
  file: Pick<SourceFile, 'name' | 'previewUrl'>,
  page?: number,
  regions?: readonly Region[]
): string | undefined {
  const citationRequested = page != null || Boolean(regions?.length);
  if (!citationRequested || !OFFICE_PREVIEW_EXTS.has(fileExt(file.name))) {
    return;
  }
  // Store-only and legacy Office files have no parser-derived PDF. Keep them
  // on the native viewer instead of guessing an endpoint that will return 404.
  return file.previewUrl || undefined;
}

function lazyView(node: ReactNode) {
  return <Suspense fallback={<FileLoading />}>{node}</Suspense>;
}

function OfficeCitationPreview({
  canEdit,
  page,
  previewUrl,
  regions,
  renderOffice,
}: {
  canEdit: boolean;
  page?: number;
  previewUrl: string;
  regions: Region[];
  renderOffice: (startEditing: boolean) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return renderOffice(true);
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      {canEdit && (
        <div className="flex min-h-10 shrink-0 justify-end border-line border-b px-2 py-1">
          <Button onClick={() => setEditing(true)} size="sm">
            {m.action_edit()}
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-auto">
        <PdfView page={page} regions={regions} url={previewUrl} />
      </div>
    </div>
  );
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
  onDirtyChange?: (dirty: boolean) => void;
  onImageZoomChange?: (next: number) => void;
  /** 1-based page to scroll to in a paginated citation preview. */
  page?: number;
  /** Parser coordinates to highlight in read-only paginated previews. */
  regions?: Region[];
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
  onDirtyChange,
  page,
  regions,
}: FileViewerProps) {
  const { data: workspace } = useWorkspace(file?.workspaceId ?? '', {
    errorBoundary: false,
  });
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
  const officeRuntimeIdentity = officeRuntimeKey(file, file.revision);
  const citationPreviewUrl = officeCitationPreviewUrl(file, page, regions);

  if (file.kind === 'pdf' || ext === 'pdf') {
    if (!file.url) return <FileEmpty />;
    return lazyView(
      <PdfView
        annotationFile={file}
        page={page}
        regions={regions}
        url={file.url}
      />
    );
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
    if (ext === 'csv' || ext === 'tsv')
      return lazyView(
        <SourceTextView
          canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
          file={file}
          key={file.id}
          onDirtyChange={onDirtyChange}
          renderPreview={(url) => <CsvView url={url ?? file.url!} />}
        />
      );
    if (ext !== 'xlsx') return <UnsupportedPreview file={file} />;
    if (citationPreviewUrl) {
      return lazyView(
        <OfficeCitationPreview
          canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
          key={file.id}
          page={page}
          previewUrl={citationPreviewUrl}
          regions={regions ?? []}
          renderOffice={(startEditing) => (
            <SheetView
              canEdit={
                workspace?.role === 'owner' || workspace?.role === 'editor'
              }
              file={file}
              key={officeRuntimeIdentity}
              onDirtyChange={onDirtyChange}
              startEditing={startEditing}
            />
          )}
        />
      );
    }
    return lazyView(
      <SheetView
        canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
        file={file}
        key={officeRuntimeIdentity}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  // DOCX uses the same read-first Office runtime; legacy binary .doc stays downloadable.
  if (ext === 'docx') {
    if (!file.url) return <FileEmpty />;
    if (citationPreviewUrl) {
      return lazyView(
        <OfficeCitationPreview
          canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
          key={file.id}
          page={page}
          previewUrl={citationPreviewUrl}
          regions={regions ?? []}
          renderOffice={(startEditing) => (
            <DocxView
              canEdit={
                workspace?.role === 'owner' || workspace?.role === 'editor'
              }
              file={file}
              key={officeRuntimeIdentity}
              onDirtyChange={onDirtyChange}
              startEditing={startEditing}
            />
          )}
        />
      );
    }
    return lazyView(
      <DocxView
        canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
        file={file}
        key={officeRuntimeIdentity}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  if (file.kind === 'slides' || SLIDE_EXTS.has(ext)) {
    if (!file.url) return <FileEmpty />;
    if (ext !== 'pptx') return <UnsupportedPreview file={file} />;
    if (citationPreviewUrl) {
      return lazyView(
        <OfficeCitationPreview
          canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
          key={file.id}
          page={page}
          previewUrl={citationPreviewUrl}
          regions={regions ?? []}
          renderOffice={(startEditing) => (
            <PptxView
              canEdit={
                workspace?.role === 'owner' || workspace?.role === 'editor'
              }
              file={file}
              key={officeRuntimeIdentity}
              onDirtyChange={onDirtyChange}
              startEditing={startEditing}
            />
          )}
        />
      );
    }
    return lazyView(
      <PptxView
        canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
        file={file}
        key={officeRuntimeIdentity}
        onDirtyChange={onDirtyChange}
      />
    );
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
      <SourceTextView
        canEdit={workspace?.role === 'owner' || workspace?.role === 'editor'}
        file={file}
        key={file.id}
        onDirtyChange={onDirtyChange}
        renderPreview={(url) => (
          <TextView
            content={url ? undefined : file.content}
            markdown={isMarkdown}
            url={url ?? file.url}
          />
        )}
      />
    );
  }

  return <UnsupportedPreview file={file} />;
}
