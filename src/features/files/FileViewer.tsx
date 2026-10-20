import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fileLinksQuery, useFileLinks, useWorkspace } from '@/api/hooks';
import type {
  Region,
  SourceFile,
  StorageFullBy,
  ViewableFile,
} from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { ImageViewer } from '@/features/files/ImageViewer';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import {
  FileEmpty,
  FileError,
  FileLoading,
  StorageFullBanner,
} from './FileStates';
import {
  fileExt,
  IMAGE_MIN_ZOOM,
  isImageFile,
  officeFormatOf,
} from './fileUtils';
import type { OfficeCitation, OfficeFormat } from './officeProtocol';
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
const SHEET_EXTS = new Set(['csv', 'tsv']);
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
  const { data: workspace, isPending: workspacePending } = useWorkspace(
    file?.workspaceId ?? '',
    { errorBoundary: false }
  );
  const frozen = useAccountFrozen();
  // An Office file opens from its source session (sourceOpen.ts), never from
  // the published file's link.
  const office = file?.hasBytes ? officeFormatOf(file) : null;
  // The row only says bytes exist; B2 needs a presigned link the
  // bearer-authenticated API hands out per file.
  const {
    data: links,
    error: linksError,
    isPending: linksPending,
    isError: linksFailed,
    refetch: refetchLinks,
  } = useFileLinks(file?.hasBytes && !office ? file.id : '', {
    errorBoundary: false,
  });
  // Private marks need only the file id. Reading them here runs alongside the
  // link fetch instead of after the whole PDF downloads; the overlay draws them
  // once the pages exist, so the document never waits on this.
  const isPdf =
    !!file?.hasBytes && (file.kind === 'pdf' || fileExt(file.name) === 'pdf');
  const {
    errorUpdatedAt: annotationsErrorUpdatedAt,
    isError: annotationsFailed,
  } = useQuery({
    ...pdfAnnotationsQuery(file?.id ?? ''),
    enabled: isPdf,
  });
  useEffect(() => {
    if (!isPdf || !annotationsFailed || !annotationsErrorUpdatedAt) return;
    const id = userToast({
      id: `pdf-annotations:${file?.id}`,
      title: m.pdf_annotations_failed(),
      variant: 'error',
    });
    return () => {
      toast.dismiss(id);
    };
  }, [annotationsErrorUpdatedAt, annotationsFailed, file?.id, isPdf]);
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
  const canEdit = !!workspace?.capabilities.canEditContent;
  if (office) {
    // The capability picks View or Edit once, when the view mounts.
    if (workspacePending) return <FileLoading />;
    return (
      <OfficeFileView
        canEdit={canEdit}
        citation={citation}
        file={file}
        format={office}
        onDirtyChange={onDirtyChange}
      />
    );
  }
  if (linksPending) return <FileLoading />;
  if (linksFailed || !links) {
    return (
      <FileError
        errorId={unexpectedErrorId(linksError)}
        onRetry={() => void refetchLinks()}
      />
    );
  }
  return (
    <ResolvedFileView
      annotationsReadOnly={frozen || !!links.storageFull}
      canEdit={canEdit}
      file={{ ...file, url: links.url }}
      imageZoom={imageZoom}
      onDirtyChange={onDirtyChange}
      onImageZoomChange={onImageZoomChange}
      onRetryLinks={() => refetchLinks()}
      page={page}
      regions={regions}
      storageFull={links.storageFull}
    />
  );
}

/** DOCX, XLSX and PPTX in the Office runtime, keyed by the file so a switch
 * leaves no session or frame of the previous one. */
function OfficeFileView({
  format,
  ...props
}: {
  canEdit: boolean;
  citation?: OfficeCitation;
  file: SourceFile;
  format: OfficeFormat;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const key = officeRuntimeKey(props.file, props.file.revision);
  if (format === 'xlsx') return lazyView(<SheetView key={key} {...props} />);
  if (format === 'docx') return lazyView(<DocxView key={key} {...props} />);
  return lazyView(<PptxView key={key} {...props} />);
}

function ResolvedFileView({
  annotationsReadOnly,
  canEdit,
  file,
  imageZoom,
  onDirtyChange,
  onImageZoomChange,
  onRetryLinks,
  page,
  regions,
  storageFull,
}: Omit<FileViewerProps, 'citation' | 'file' | 'imageZoom'> & {
  /** PDF marks are open to every reader but not to a frozen account or while
   * the file's payer is at its storage limit. */
  annotationsReadOnly: boolean;
  /** Content controls follow the workspace capabilities, which the reader's
   * frozen account turns off. */
  canEdit: boolean;
  file: ViewableFile;
  imageZoom: number;
  onRetryLinks: () => Promise<unknown>;
  /** The file's payer (its uploader) is at its storage limit. */
  storageFull?: StorageFullBy;
}) {
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const retryPreview = async () => {
    await onRetryLinks();
    // Restart even when the signer returns the same URL. Keep source editors mounted.
    setPreviewAttempt((attempt) => attempt + 1);
  };
  const ext = fileExt(file.name);

  if (file.kind === 'pdf' || ext === 'pdf') {
    const pdf = lazyView(
      <PdfView
        annotationFile={file}
        annotationsReadOnly={annotationsReadOnly}
        onDirtyChange={onDirtyChange}
        onRetry={onRetryLinks}
        page={page}
        regions={regions}
        url={file.url}
      />
    );
    if (!storageFull) return pdf;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StorageFullBanner by={storageFull} />
        <div className="min-h-0 flex-1">{pdf}</div>
      </div>
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
    // XLSX opens in OfficeFileView.
    return <UnsupportedPreview file={file} />;
  }

  // PPTX opens in OfficeFileView; legacy binary .ppt (and .doc) stays
  // downloadable.
  if (file.kind === 'slides') return <UnsupportedPreview file={file} />;

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
