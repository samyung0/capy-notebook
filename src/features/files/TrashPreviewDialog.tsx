import { Dialog as DialogPrimitive } from 'radix-ui';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { useTrashPreview } from '@/api/hooks';
import type { Material, TrashItem, TrashPreview } from '@/api/types';
import { TabContent } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent } from '@/components/ui/Dialog';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { IconButton } from '@/components/ui/IconButton';
import { FlashcardGrid } from '@/features/flashcards/FlashcardGrid';
import {
  EmbedUnavailable,
  EmbedViewContext,
} from '@/features/materials/embeds/EmbedView';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { MermaidMaterialView } from '@/features/materials/MermaidMaterialView';
import { storedCards, storedQuestions } from '@/features/materials/storedItems';
import { getLocale, m } from '@/i18n';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import { FileError, FileLoading } from './FileStates';
import { AudioView } from './FileViewer';
import { FileHeaderTarget } from './fileModeContext';
import { fileExt, isImageFile, TEXT_EXTS } from './fileUtils';
import { ImageViewer } from './ImageViewer';
import { applySavedSource } from './sourceState';

const PdfView = lazy(() => import('./PdfView'));
const CsvView = lazy(() => import('./CsvView'));
const TextView = lazy(() => import('./TextView'));
const QuizReadSplit = lazy(() =>
  import('@/features/quizzes/QuizEditor').then((module) => ({
    default: module.QuizReadSplit,
  }))
);
const MaterialPreview = lazy(() =>
  import('@/features/materials/MaterialPreview').then((module) => ({
    default: module.MaterialPreview,
  }))
);

/**
 * A trashed file or material opened read-only from the Trash list (Epo
 * 2026-11-12): nothing joins a room or edits, and Restore is the way back to
 * editing. A note's embedded quizzes and sets are trashed with it, so they
 * show as unavailable. Office files and boards show their thumbnail: their
 * viewers open only live files. Default export: Files loads it on first open.
 */
export default function TrashPreviewDialog({
  icon,
  item,
  onClose,
  onRestore,
}: {
  icon: FileIconName;
  item: TrashItem | null;
  onClose: () => void;
  onRestore: (item: TrashItem) => void;
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!item}>
      {item && (
        <TrashPreviewContent
          icon={icon}
          item={item}
          onClose={onClose}
          onRestore={onRestore}
        />
      )}
    </Dialog>
  );
}

function TrashPreviewContent({
  icon,
  item,
  onClose,
  onRestore,
}: {
  icon: FileIconName;
  item: TrashItem;
  onClose: () => void;
  onRestore: (item: TrashItem) => void;
}) {
  // PDF page count and zoom sit in this header, as in an open file's.
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  return (
    <DialogContent
      aria-describedby={undefined}
      // Phones: full screen, clear of the home indicator.
      cardScrollContainerClassName="h-[88dvh] overflow-hidden p-0 sm:p-0 max-sm:h-dvh max-sm:p-0 max-sm:pb-[env(safe-area-inset-bottom)]"
      className="max-w-5xl"
      showCloseButton={false}
    >
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-divider border-b px-3 sm:px-4">
        <FileIcon className="size-5 shrink-0" name={icon} />
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="t-body truncate font-semibold">
            {item.title}
          </DialogPrimitive.Title>
          <p className="t-meta truncate text-fg-muted">
            {m.trash_preview_note({
              date: new Intl.DateTimeFormat(getLocale(), {
                dateStyle: 'medium',
              }).format(new Date(item.purgeAfter)),
            })}
          </p>
        </div>
        <div
          className="flex shrink-0 items-center gap-1 empty:hidden max-sm:hidden"
          ref={setHeaderTarget}
        />
        {/* Restoring needs edit access to its workspace. */}
        {item.canRestore && (
          <Button
            className="px-2.5"
            iconLeft="undo"
            onClick={() => onRestore(item)}
            size="md"
            variant="outline"
          >
            {m.trash_restore()}
          </Button>
        )}
        <IconButton
          icon="x"
          label={m.action_close()}
          onClick={onClose}
          size="md"
          variant="ghost-hover"
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto">
        <FileHeaderTarget value={headerTarget}>
          <TrashPreviewBody item={item} />
        </FileHeaderTarget>
      </div>
    </DialogContent>
  );
}

function TrashPreviewBody({ item }: { item: TrashItem }) {
  const { data, error, isError, isPending, refetch } = useTrashPreview(item);
  if (isPending) return <FileLoading />;
  const retry = () => void refetch();
  if (isError) {
    const { description, title } = describeError(error);
    return (
      <FileError
        errorId={unexpectedErrorId(error)}
        message={description}
        onRetry={retry}
        title={title}
      />
    );
  }
  if (data.material) {
    return (
      <MaterialBody assets={data.assets} item={item} material={data.material} />
    );
  }
  if (data.file && data.links) {
    return <FileBody item={item} onRetry={retry} preview={data} />;
  }
  return <RestoreToOpen item={item} />;
}

/** A trashed note's embeds are trashed with it. */
function EmbedGone() {
  return <EmbedUnavailable />;
}

/** As the workspace reads each kind without a room: a quiz in its read
 * split (its learner questions carry no key), a set as its card grid. Images
 * and audio load from the links the preview signed. */
function MaterialBody({
  assets,
  item,
  material,
}: {
  assets?: Record<string, string>;
  item: TrashItem;
  material: Material;
}) {
  const { content, kind, title } = material;
  let body: ReactNode;
  if (kind === 'mindmap' || kind === 'diagram') {
    body = (
      <MermaidMaterialView
        content={content}
        material={{ isStandalone: true, kind, title }}
      />
    );
  } else if (kind === 'quiz') {
    body = <QuizReadSplit questions={storedQuestions(content)} />;
  } else if (kind === 'flashcards') {
    body = (
      <TabContent>
        <FlashcardGrid cards={storedCards(content)} title={title} />
      </TabContent>
    );
  } else if (kind === 'canvas') {
    return <RestoreToOpen item={item} />;
  } else {
    body = (
      <EmbedViewContext value={EmbedGone}>
        <MaterialPreview
          content={content}
          isStandalone
          kind={kind}
          title={title}
        />
      </EmbedViewContext>
    );
  }
  return (
    <AssetUrlContext value={(assetId) => assets?.[assetId]}>
      <Suspense fallback={<FileLoading />}>{body}</Suspense>
    </AssetUrlContext>
  );
}

function FileBody({
  item,
  onRetry,
  preview,
}: {
  item: TrashItem;
  onRetry: () => void;
  preview: TrashPreview;
}) {
  const file = preview.file!;
  const url = preview.links!.url;
  const ext = fileExt(file.name);
  const [zoom, setZoom] = useState(1);
  const textURL = useSavedText(preview);
  if (textURL === null) return <FileLoading />;
  const lazyView = (node: ReactNode) => (
    <Suspense fallback={<FileLoading />}>{node}</Suspense>
  );
  if (file.kind === 'pdf' || ext === 'pdf') {
    return lazyView(<PdfView onRetry={onRetry} url={url} />);
  }
  if (isImageFile(file)) {
    return (
      <ImageViewer
        alt={file.name}
        onRetry={onRetry}
        onZoomChange={setZoom}
        url={url}
        zoom={zoom}
      />
    );
  }
  if (file.kind === 'audio') {
    return <AudioView file={{ ...file, url }} onRetry={onRetry} />;
  }
  if (ext === 'csv' || ext === 'tsv') {
    return lazyView(<CsvView onRetry={onRetry} url={textURL ?? url} />);
  }
  const markdown = file.kind === 'md' || ext === 'md' || ext === 'markdown';
  if (
    markdown ||
    file.kind === 'txt' ||
    file.kind === 'json' ||
    TEXT_EXTS.has(ext)
  ) {
    return lazyView(
      <TextView markdown={markdown} onRetry={onRetry} url={textURL ?? url} />
    );
  }
  return <RestoreToOpen item={item} />;
}

/** A text file's saved edits ahead of its bytes, as a URL (undefined when the
 * bytes are current, or the file is not text); null until the saved state is
 * read, so the view never fetches the older bytes first. */
function useSavedText(preview: TrashPreview) {
  const { source } = preview;
  const [saved, setSaved] = useState<{ for: typeof source; url?: string }>();
  useEffect(() => {
    if (!source) return;
    const doc = new Y.Doc();
    let url: string | undefined;
    if (applySavedSource(doc, source)) {
      url = URL.createObjectURL(
        new Blob([doc.getText('source').toString()], {
          type: 'text/plain;charset=utf-8',
        })
      );
    }
    doc.destroy();
    setSaved({ for: source, url });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [source]);
  if (!source) return;
  return saved?.for === source ? saved.url : null;
}

/** Office files (their thumbnail) and boards: Restore opens them. */
function RestoreToOpen({ item }: { item: TrashItem }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      {item.thumbnailUrl && (
        <img
          alt=""
          className="max-h-[60%] max-w-full rounded-card border border-divider object-contain"
          src={item.thumbnailUrl}
        />
      )}
      <p className="t-body text-fg-muted">
        {m.trash_preview_restore_to_open()}
      </p>
    </div>
  );
}
