import { useQueryClient } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import {
  fileLinksQuery,
  useFileLinks,
  useOfficePreviewLinks,
  useWorkspace,
} from '@/api/hooks';
import type {
  Region,
  SourceFile,
  ViewableFile,
  WorkspaceRole,
} from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ImageViewer } from '@/features/files/ImageViewer';
import { m } from '@/i18n';
import { FileEmpty, FileError, FileLoading } from './FileStates';
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

/** Whether a citation on this Office file opens the parser-derived PDF. The
 * row's `previewUrl` is a presence marker; the preview resolves its own link. */
export function hasOfficeCitationPreview(
  file: Pick<SourceFile, 'name' | 'previewUrl'>,
  page?: number,
  regions?: readonly Region[]
): boolean {
  const citationRequested = page != null || Boolean(regions?.length);
  if (!citationRequested || !OFFICE_PREVIEW_EXTS.has(fileExt(file.name))) {
    return false;
  }
  // Store-only and legacy Office files have no parser-derived PDF. Keep them
  // on the native viewer instead of guessing an endpoint that will return 404.
  return Boolean(file.previewUrl);
}

function lazyView(node: ReactNode) {
  return <Suspense fallback={<FileLoading />}>{node}</Suspense>;
}

/** Resolves its own presigned pair when it opens, so the preview PDF is
 * fetched with a fresh link however long the file itself has been open. */
function OfficeCitationPreview({
  canEdit,
  fileId,
  page,
  regions,
  renderOffice,
}: {
  canEdit: boolean;
  fileId: string;
  page?: number;
  regions: Region[];
  renderOffice: (startEditing: boolean) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const {
    data: links,
    isPending,
    refetch,
  } = useOfficePreviewLinks(editing ? '' : fileId, { errorBoundary: false });
  if (editing) return renderOffice(true);
  if (isPending) return <FileLoading />;
  if (!links?.previewUrl) return <FileError onRetry={() => void refetch()} />;
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
        <PdfView page={page} regions={regions} url={links.previewUrl} />
      </div>
    </div>
  );
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
        <Icon name="files" size={32} />
        <p className="t-subtitle">{m.files_preview_unavailable()}</p>
        <p className="t-meta text-fg-muted">
          {ext
            ? m.files_preview_unsupported_body({ ext: `.${ext}` })
            : m.files_preview_unsupported_body_noext()}
        </p>
        <Button onClick={download} size="sm" variant="ghost">
          {m.files_download_original({ name: file.name })}
        </Button>
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
  // The row only says bytes exist; B2 needs a presigned link the
  // bearer-authenticated API hands out per file.
  const {
    data: links,
    isPending: linksPending,
    isError: linksFailed,
    refetch: refetchLinks,
  } = useFileLinks(file?.hasBytes ? file.id : '', { errorBoundary: false });
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

  if (!file.hasBytes) return <FileEmpty />;
  if (linksPending) return <FileLoading />;
  if (linksFailed || !links) {
    return <FileError onRetry={() => void refetchLinks()} />;
  }
  return (
    <ResolvedFileView
      file={{ ...file, url: links.url }}
      imageZoom={imageZoom}
      onDirtyChange={onDirtyChange}
      onImageZoomChange={onImageZoomChange}
      onRetryLinks={() => void refetchLinks()}
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
  workspaceRole,
}: Omit<FileViewerProps, 'file' | 'imageZoom'> & {
  file: ViewableFile;
  imageZoom: number;
  onRetryLinks: () => void;
  workspaceRole?: WorkspaceRole;
}) {
  const canEdit = workspaceRole === 'owner' || workspaceRole === 'editor';
  const ext = fileExt(file.name);
  const officeRuntimeIdentity = officeRuntimeKey(file, file.revision);
  const citationPreview = hasOfficeCitationPreview(file, page, regions);

  if (file.kind === 'pdf' || ext === 'pdf') {
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
    return <AudioView file={file} key={file.url} onRetry={onRetryLinks} />;
  }

  if (file.kind === 'sheet' || SHEET_EXTS.has(ext)) {
    if (ext === 'csv' || ext === 'tsv')
      return lazyView(
        <SourceTextView
          canEdit={canEdit}
          file={file}
          key={file.id}
          onDirtyChange={onDirtyChange}
          renderPreview={(url) => <CsvView url={url ?? file.url} />}
        />
      );
    if (ext !== 'xlsx') return <UnsupportedPreview file={file} />;
    if (citationPreview) {
      return lazyView(
        <OfficeCitationPreview
          canEdit={canEdit}
          fileId={file.id}
          key={file.id}
          page={page}
          regions={regions ?? []}
          renderOffice={(startEditing) => (
            <SheetView
              canEdit={canEdit}
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
        canEdit={canEdit}
        file={file}
        key={officeRuntimeIdentity}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  // DOCX uses the same read-first Office runtime; legacy binary .doc stays downloadable.
  if (ext === 'docx') {
    if (citationPreview) {
      return lazyView(
        <OfficeCitationPreview
          canEdit={canEdit}
          fileId={file.id}
          key={file.id}
          page={page}
          regions={regions ?? []}
          renderOffice={(startEditing) => (
            <DocxView
              canEdit={canEdit}
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
        canEdit={canEdit}
        file={file}
        key={officeRuntimeIdentity}
        onDirtyChange={onDirtyChange}
      />
    );
  }

  if (file.kind === 'slides' || SLIDE_EXTS.has(ext)) {
    if (ext !== 'pptx') return <UnsupportedPreview file={file} />;
    if (citationPreview) {
      return lazyView(
        <OfficeCitationPreview
          canEdit={canEdit}
          fileId={file.id}
          key={file.id}
          page={page}
          regions={regions ?? []}
          renderOffice={(startEditing) => (
            <PptxView
              canEdit={canEdit}
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
        canEdit={canEdit}
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
          <TextView markdown={isMarkdown} url={url ?? file.url} />
        )}
      />
    );
  }

  return <UnsupportedPreview file={file} />;
}
