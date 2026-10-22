import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
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
import { OfficeInsetContext } from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { ImageViewer } from '@/features/files/ImageViewer';
import { onPhone, tabHidden } from '@/features/notes/roomSwap';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import {
  FileEmpty,
  FileError,
  FileLoading,
  StorageFullBanner,
} from './FileStates';
import {
  EditorStatusContext,
  FileActionsTarget,
  FileHeaderTarget,
  FileMenuShown,
  FileMenuTarget,
  PresenceContext,
} from './fileModeContext';
import {
  fileExt,
  IMAGE_MIN_ZOOM,
  isImageFile,
  officeFormatOf,
} from './fileUtils';
import type {
  OfficeCitation,
  OfficeFormat,
  OfficePosition,
} from './officeProtocol';
import { SourceTextView } from './SourceTextView';
import { type OfficeViewPosition, officeRuntimeKey } from './useOfficeRuntime';
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

interface OfficeFileProps {
  canEdit: boolean;
  citation?: OfficeCitation;
  file: SourceFile;
  format: OfficeFormat;
  onDirtyChange?: (dirty: boolean) => void;
}

/** DOCX, XLSX and PPTX in the Office runtime, keyed by the file so a switch
 * leaves no session or frame of the previous one. */
function OfficeFileView(props: OfficeFileProps) {
  return lazyView(
    <OfficeSwap
      key={officeRuntimeKey(props.file, props.file.revision)}
      {...props}
    />
  );
}

/**
 * A newer epoch while the editor is saved (a base handoff, a discard's epoch
 * reset) swaps renderers instead of a reload banner (Epo 2026-10-22): the
 * paused view stays on screen while a second view, with its own frame and
 * session, opens the new epoch hidden beside it, and takes the screen once
 * it is ready. A hidden tab swaps at once, and so does a phone, which holds
 * one frame. Each view keeps its own slot: a frame moved in the DOM reloads.
 */
function OfficeSwap({ format, onDirtyChange, ...props }: OfficeFileProps) {
  // Views by generation: the one on screen and the one building beside it.
  const [views, setViews] = useState<{ next: number | null; shown: number }>({
    next: null,
    shown: 0,
  });
  const viewsRef = useRef(views);
  viewsRef.current = views;
  // Each view's frame position calls; where the next view opens after an
  // at-once swap, read before the replaced view went.
  const positions = useRef(new Map<number, OfficeViewPosition>());
  const carried = useRef<OfficePosition | null>(null);
  const read = (generation: number) =>
    positions.current.get(generation)?.read() ?? Promise.resolve(null);
  const replaced = useCallback(async (generation: number) => {
    const { next, shown } = viewsRef.current;
    // The view building was itself replaced: the next one builds instead.
    if (next === generation) {
      setViews({ next: generation + 1, shown });
      return;
    }
    if (shown !== generation || next !== null) return;
    if (!(tabHidden() || onPhone())) {
      setViews({ next: generation + 1, shown });
      return;
    }
    carried.current = await read(generation);
    if (viewsRef.current.shown === generation)
      setViews({ next: null, shown: generation + 1 });
  }, []);
  const settled = useCallback(async (generation: number) => {
    const { next, shown } = viewsRef.current;
    if (next === generation) {
      // The next view opens where the reader was, then takes the screen.
      const position = await read(shown);
      if (viewsRef.current.next !== generation) return;
      if (position) positions.current.get(generation)?.show(position);
      setViews({ next: null, shown: generation });
    } else if (shown === generation && carried.current) {
      positions.current.get(generation)?.show(carried.current);
      carried.current = null;
    }
  }, []);
  const building = views.next;
  useEffect(() => {
    if (building === null) return;
    const hidden = () => {
      if (tabHidden()) void settled(building);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [building, settled]);
  const View =
    format === 'xlsx' ? SheetView : format === 'docx' ? DocxView : PptxView;
  const generations =
    building === null ? [views.shown] : [views.shown, building];
  return (
    <div className="relative h-full">
      {generations.map((generation) => {
        const role =
          generation === building
            ? 'next'
            : building === null
              ? 'live'
              : 'replaced';
        return (
          <OfficeSlot key={generation} role={role}>
            <View
              {...props}
              onDirtyChange={role === 'next' ? undefined : onDirtyChange}
              startEditing={generation > 0}
              swap={{
                onPosition: (position) => {
                  if (position) positions.current.set(generation, position);
                  else positions.current.delete(generation);
                },
                onReplaced: () => void replaced(generation),
                onSettled: () => void settled(generation),
              }}
            />
          </OfficeSlot>
        );
      })}
    </div>
  );
}

/**
 * One Office view's slot. The view building hidden takes no input and keeps
 * out of the header (status, mode control, menus); the replaced one leaves
 * the avatar group and the floating bar's inset to it, so its unmount clears
 * neither.
 */
function OfficeSlot({
  children,
  role,
}: {
  children: ReactNode;
  role: 'live' | 'next' | 'replaced';
}) {
  const next = role === 'next';
  const leaving = role === 'replaced';
  const status = useContext(EditorStatusContext);
  const presence = useContext(PresenceContext);
  const inset = useContext(OfficeInsetContext);
  const header = useContext(FileHeaderTarget);
  const menu = useContext(FileMenuTarget);
  const actions = useContext(FileActionsTarget);
  const menuShown = useContext(FileMenuShown);
  return (
    <div
      aria-hidden={next || undefined}
      className={cn('h-full', next && 'invisible absolute inset-0')}
      data-office-view={role}
      inert={next}
    >
      <EditorStatusContext.Provider value={next ? null : status}>
        <PresenceContext.Provider value={leaving ? null : presence}>
          <OfficeInsetContext.Provider value={leaving ? null : inset}>
            <FileHeaderTarget.Provider value={next ? null : header}>
              <FileMenuTarget.Provider value={next ? null : menu}>
                <FileActionsTarget.Provider value={next ? null : actions}>
                  <FileMenuShown.Provider value={next ? null : menuShown}>
                    {children}
                  </FileMenuShown.Provider>
                </FileActionsTarget.Provider>
              </FileMenuTarget.Provider>
            </FileHeaderTarget.Provider>
          </OfficeInsetContext.Provider>
        </PresenceContext.Provider>
      </EditorStatusContext.Provider>
    </div>
  );
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
