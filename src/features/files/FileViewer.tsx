import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fileLinksQuery, useFileLinks, useWorkspace } from '@/api/hooks';
import type {
  Region,
  SourceFile,
  ViewableFile,
  WorkspaceRole,
} from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { ImageViewer } from '@/features/files/ImageViewer';
import { m } from '@/i18n';
import { FileEmpty, FileError, FileLoading } from './FileStates';
import { fileExt, IMAGE_MIN_ZOOM, isImageFile } from './fileUtils';
import type { OfficeCitation } from './officeProtocol';
import { SourceTextView } from './SourceTextView';
import { officeRuntimeKey } from './useOfficeRuntime';
import { pdfAnnotationsQuery } from './usePdfAnnotations';

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
function lazyView(node: ReactNode) {
  return <Suspense fallback={<FileLoading />}>{node}</Suspense>;
}

/** Seeking past the buffered range re-reads the URL, which may have expired by
 * then; the retry fetches a fresh pair and the new URL remounts this view. */
function AudioView({
  file,
  onRetry,
}: {
  file: ViewableFile;
  onRetry: () => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileError onRetry={onRetry} />;
  return (
    <div className="grid h-full place-items-center">
      <div className="flex w-full max-w-140 flex-col items-center gap-3">
        <p className="t-subtitle">{file.name}</p>
        <audio
          className="w-full"
          controls
          onError={() => setFailed(true)}
          src={file.url}
        />
      </div>
    </div>
  );
}

function UnsupportedPreview({ file }: { file: ViewableFile }) {
  const ext = fileExt(file.name);
  const queryClient = useQueryClient();
  // The link is signed when clicked, not when the view opened: open the tab
  // first so the navigation stays inside the click's popup allowance.
  const download = () => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    queryClient.fetchQuery(fileLinksQuery(file.id)).then(
      (links) => {
        if (tab) tab.location.href = links.url;
      },
      () => tab?.close()
    );
  };
  return (
    <div className="grid h-full place-items-center">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <Icon className="non-scaling-svg size-8" name="files" />
        <p className="t-subtitle">{m.files_preview_unavailable()}</p>
        <p className="t-meta text-fg-muted">
          {ext
            ? m.files_preview_unsupported_body({ ext: `.${ext}` })
            : m.files_preview_unsupported_body_noext()}
        </p>
        <Button
          iconLeft="download"
          iconLeftClassName="me-1"
          onClick={download}
          variant="ghost-hover"
        >
          {m.files_download_original({ name: file.name })}
        </Button>
      </div>
    </div>
  );
}

interface FileViewerProps {
  citation?: OfficeCitation;
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
  citation,
}: FileViewerProps) {
  const { data: workspace } = useWorkspace(file?.workspaceId ?? '', {
    errorBoundary: false,
  });
  // The row only says bytes exist; B2 needs a presigned link the
  // bearer-authenticated API hands out per file.
  const {
    data: links,
    isPending: linksPending,
    isError: linksFailed,
    refetch: refetchLinks,
  } = useFileLinks(file?.hasBytes ? file.id : '', { errorBoundary: false });
  // Private marks need only the file id. Reading them here runs alongside the
  // link fetch instead of after the whole PDF downloads; the overlay draws them
  // once the pages exist, so the document never waits on this.
  const isPdf =
    !!file?.hasBytes && (file.kind === 'pdf' || fileExt(file.name) === 'pdf');
  const {
    errorUpdatedAt: annotationsErrorUpdatedAt,
    isError: annotationsFailed,
    refetch: refetchAnnotations,
  } = useQuery({
    ...pdfAnnotationsQuery(file?.id ?? ''),
    enabled: isPdf,
  });
  useEffect(() => {
    if (!isPdf || !annotationsFailed || !annotationsErrorUpdatedAt) return;
    const id = userToast({
      button: {
        label: m.error_action_retry(),
        onClick: () => void refetchAnnotations(),
      },
      id: `pdf-annotations:${file?.id}`,
      title: m.pdf_annotations_failed(),
      variant: 'error',
    });
    return () => {
      toast.dismiss(id);
    };
  }, [
    annotationsErrorUpdatedAt,
    annotationsFailed,
    file?.id,
    isPdf,
    refetchAnnotations,
  ]);
  if (!file) {
    // TODO: shouldnt this throw errors?
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-2">
          <Icon className="non-scaling-svg size-8" name="files" />
          <p>{m.files_select_to_read()}</p>
        </div>
      </div>
    );
  }

  if (!file.hasBytes) return <FileEmpty />;
  if (linksPending) return <FileLoading />;
  if (linksFailed || !links) {
    return <FileError onRetry={() => void refetchLinks()} />;
  }
  return (
    <ResolvedFileView
      citation={citation}
      file={{ ...file, url: links.url }}
      imageZoom={imageZoom}
      onDirtyChange={onDirtyChange}
      onImageZoomChange={onImageZoomChange}
      onRetryLinks={() => refetchLinks()}
      page={page}
      regions={regions}
      workspaceRole={workspace?.role}
    />
  );
}

function ResolvedFileView({
  file,
  imageZoom,
  onDirtyChange,
  onImageZoomChange,
  onRetryLinks,
  page,
  regions,
  citation,
  workspaceRole,
}: Omit<FileViewerProps, 'file' | 'imageZoom'> & {
  file: ViewableFile;
  imageZoom: number;
  onRetryLinks: () => Promise<unknown>;
  workspaceRole?: WorkspaceRole;
}) {
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const retryPreview = async () => {
    await onRetryLinks();
    // Restart even when the signer returns the same URL. Keep source editors mounted.
    setPreviewAttempt((attempt) => attempt + 1);
  };
  const canEdit = workspaceRole === 'owner' || workspaceRole === 'editor';
  const ext = fileExt(file.name);
  const officeRuntimeIdentity = officeRuntimeKey(file, file.revision);

  if (file.kind === 'pdf' || ext === 'pdf') {
    return lazyView(
      <PdfView
        annotationFile={file}
        onDirtyChange={onDirtyChange}
        onRetry={onRetryLinks}
        page={page}
        regions={regions}
        url={file.url}
      />
    );
  }

  if (isImageFile(file)) {
    return (
      <ImageViewer
        alt={file.name}
        key={`${file.url}:${previewAttempt}`}
        onRetry={retryPreview}
        onZoomChange={onImageZoomChange}
        url={file.url}
        zoom={imageZoom}
      />
    );
  }

  if (file.kind === 'audio' || AUDIO_EXTS.has(ext)) {
    return (
      <AudioView
        file={file}
        key={`${file.url}:${previewAttempt}`}
        onRetry={retryPreview}
      />
    );
  }

  if (file.kind === 'sheet' || SHEET_EXTS.has(ext)) {
    if (ext === 'csv' || ext === 'tsv')
      return lazyView(
        <SourceTextView
          canEdit={canEdit}
          file={file}
          key={file.id}
          onDirtyChange={onDirtyChange}
          renderPreview={(url) => (
            <CsvView
              key={`${url ?? file.url}:${previewAttempt}`}
              onRetry={retryPreview}
              url={url ?? file.url}
            />
          )}
        />
      );
    if (ext !== 'xlsx') return <UnsupportedPreview file={file} />;
    return lazyView(
      <SheetView
        canEdit={canEdit}
        citation={citation}
        file={file}
        key={officeRuntimeIdentity}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  // DOCX uses the same read-first Office runtime; legacy binary .doc stays downloadable.
  if (ext === 'docx') {
    return lazyView(
      <DocxView
        canEdit={canEdit}
        citation={citation}
        file={file}
        key={officeRuntimeIdentity}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  if (file.kind === 'slides' || SLIDE_EXTS.has(ext)) {
    if (ext !== 'pptx') return <UnsupportedPreview file={file} />;
    return lazyView(
      <PptxView
        canEdit={canEdit}
        citation={citation}
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
    return lazyView(
      <SourceTextView
        canEdit={canEdit}
        file={file}
        key={file.id}
        onDirtyChange={onDirtyChange}
        renderPreview={(url) => (
          <TextView
            key={`${url ?? file.url}:${previewAttempt}`}
            markdown={isMarkdown}
            onRetry={retryPreview}
            url={url ?? file.url}
          />
        )}
      />
    );
  }

  return <UnsupportedPreview file={file} />;
}
