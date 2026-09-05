import { lazy, Suspense, useEffect, useState } from 'react';
import { isMaterialContentUnreadable } from '@/api/client';
import { useFile, useMaterial, useMaterials } from '@/api/hooks';
import type { Chapter, Region, UserColor } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import {
  FileError,
  FileLoading,
  FileNotIndexedBanner,
} from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { fileIsIngesting, IMAGE_MIN_ZOOM } from '@/features/files/fileUtils';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { Header } from './CenterContentHeader';
import { HeavyMaterialGate } from './HeavyMaterialGate';
import { type HeavyMaterialChoice, heavyMaterial } from './heavyDocument';
import {
  isInteractiveMaterialMode,
  type MaterialMode,
  materialModePolicy,
  resolveMaterialMode,
} from './modePolicy';
import type { OpenItem } from './openItem';

/* Interactive Plate is the heaviest chunk in this route. View mode
 * deliberately never loads it. */
const NoteEditor = lazy(() =>
  import('@/features/notes/NoteEditor').then((m) => ({
    default: m.NoteEditor,
  }))
);

/* Static Plate preview is still heavy — keep it out of the PDF / media path. */
const MaterialPreview = lazy(() =>
  import('./MaterialPreview').then((m) => ({ default: m.MaterialPreview }))
);

/** The center pane. Dispatches on the currently-open item — a source file or a
 * study material — and renders a consistent header plus the item body. Quiz and
 * flashcards materials get view actions in the header; mindmaps/diagrams render inline.
 * User-authored notes take over the whole pane with the editable Plate editor. */
export function CenterContent({
  beforeFileDelete,
  chapters,
  item,
  readOnly = false,
  color,
  onDeleted,
  onFileViewerDirtyChange,
  requestedMode = null,
  workspaceId,
}: {
  beforeFileDelete?: () => boolean;
  chapters: Chapter[];
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
  onDeleted: () => void;
  onFileViewerDirtyChange?: (dirty: boolean) => void;
  requestedMode?: MaterialMode | null;
  workspaceId: string;
}) {
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  const [materialMode, setMaterialMode] = useState<MaterialMode | null>(
    requestedMode
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editorStatus, setEditorStatus] = useState<NoteEditorStatus | null>(
    null
  );

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setMaterialMode(requestedMode);
    setEditorStatus(null);
    setIsFullscreen(false);
  }, [item?.kind, item?.id, requestedMode]);

  const changeMaterialMode = (nextMode: MaterialMode) => {
    setEditorStatus(null);
    setMaterialMode(nextMode);
  };

  if (!item) {
    return <EmptyCenter />;
  }
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col bg-surface',
        isFullscreen && 'fixed inset-0 z-40'
      )}
    >
      <Header
        beforeFileDelete={beforeFileDelete}
        chapters={chapters}
        color={color}
        editorStatus={editorStatus}
        imageZoom={imageZoom}
        isFullscreen={isFullscreen}
        item={item}
        materialMode={materialMode}
        onDeleted={onDeleted}
        onImageZoomChange={setImageZoom}
        onMaterialModeChange={changeMaterialMode}
        onToggleFullscreen={() => setIsFullscreen((value) => !value)}
        readOnly={readOnly}
        workspaceId={workspaceId}
      />
      <div
        className={cn(
          'relative min-h-0 flex-1',
          item.kind === 'file'
            ? 'flex flex-col overflow-hidden'
            : 'overflow-auto'
        )}
      >
        {item.kind === 'material' && (
          <MaterialBody
            allowExternalAssets={!readOnly}
            key={item.id}
            materialId={item.id}
            mode={materialMode}
            onEditorStatusChange={setEditorStatus}
            workspaceId={workspaceId}
          />
        )}
        {item.kind === 'file' && (
          <FileBody
            color={color}
            fileId={item.id}
            imageZoom={imageZoom}
            onImageZoomChange={setImageZoom}
            onViewerDirtyChange={onFileViewerDirtyChange}
            page={item.page}
            regions={item.regions}
          />
        )}
      </div>
    </div>
  );
}

/** Gates the fetch on a confirmation when the list metadata says the document
 * is heavy. The weight comes from the already-cached material list, so nothing
 * of the document itself is downloaded before the reader chooses. Keyed by
 * material id at the call site: resetting the choice in an effect would let the
 * next document start fetching for the render before the reset lands. */
function MaterialBody({
  materialId,
  workspaceId,
  mode,
  allowExternalAssets,
  onEditorStatusChange,
}: {
  materialId: string;
  workspaceId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
}) {
  const { data: materials, isPending } = useMaterials(workspaceId);
  const [choice, setChoice] = useState<HeavyMaterialChoice | null>(null);

  // Wait for the list before deciding. Rendering first and gating afterwards
  // would download the very document the gate exists to avoid, then throw the
  // mounted editor away.
  if (workspaceId && isPending) return <FileLoading />;

  const reference = materials?.find((entry) => entry.id === materialId);
  const heavy = heavyMaterial(reference);
  if (heavy && !choice) {
    return (
      <HeavyMaterialGate
        material={heavy}
        onChoose={setChoice}
        title={reference?.title ?? 'This note'}
      />
    );
  }

  return (
    <MaterialContent
      allowExternalAssets={allowExternalAssets}
      forceReadOnly={choice === 'readOnly'}
      materialId={materialId}
      mode={mode}
      onEditorStatusChange={onEditorStatusChange}
    />
  );
}

function MaterialContent({
  materialId,
  mode,
  allowExternalAssets,
  forceReadOnly,
  onEditorStatusChange,
}: {
  materialId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  forceReadOnly: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
}) {
  const {
    data: material,
    error,
    isLoading,
  } = useMaterial(materialId, {
    errorBoundary: false,
  });
  if (isLoading) {
    return <FileLoading />;
  }
  if (error || !material) {
    return isMaterialContentUnreadable(error) ? (
      <FileError
        message={m.material_decode_body()}
        title={m.material_decode_title()}
      />
    ) : (
      <FileError />
    );
  }
  const policy = materialModePolicy(material.kind, material.capabilities);
  const activeMode = forceReadOnly ? 'view' : resolveMaterialMode(mode, policy);

  return (
    <div className="h-full min-h-0">
      {activeMode === 'view' && (
        <div className="h-full min-h-0 overflow-auto">
          <Suspense fallback={<FileLoading />}>
            <MaterialPreview
              content={material.content}
              isStandalone={!material.workspaceId}
              kind={material.kind}
              title={material.title}
            />
          </Suspense>
        </div>
      )}
      {isInteractiveMaterialMode(activeMode) && (
        <AppErrorBoundary resetKeys={[materialId, activeMode]}>
          <Suspense fallback={<FileLoading />}>
            <NoteEditor
              allowExternalAssets={allowExternalAssets}
              key={`${materialId}:${activeMode}`}
              materialId={materialId}
              mode={activeMode}
              onEditorStatusChange={onEditorStatusChange}
            />
          </Suspense>
        </AppErrorBoundary>
      )}
    </div>
  );
}

function EmptyCenter() {
  return (
    <>
      <div className="flex items-center gap-3 border-divider border-b px-5 py-4">
        <Icon className="size-5.5" name="files" />
        <h2 className="t-subtitle translate-y-px truncate">--</h2>
      </div>
      <div className="grid flex-1 place-items-center p-6">
        <div className="flex flex-col items-center gap-2">
          <Icon className="size-7" name="files" />
          <p>{m.material_select()}</p>
        </div>
      </div>
    </>
  );
}

function FileBody({
  fileId,
  color,
  imageZoom,
  onImageZoomChange,
  onViewerDirtyChange,
  page,
  regions,
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  onViewerDirtyChange?: (dirty: boolean) => void;
  page?: number;
  regions?: Region[];
}) {
  const {
    data: file,
    isLoading,
    isError,
  } = useFile(fileId, {
    errorBoundary: false,
  });
  if (isLoading) return <FileLoading />;
  if (!isLoading && isError) return <FileError />;
  if (file && fileIsIngesting(file.status) && !file.url) {
    const waiting = file.status === 'pending';
    return (
      <div className="grid h-full place-items-center">
        <div className="flex w-64 -translate-y-1/2 flex-col items-center gap-3">
          <Icon className="size-7" name="sparkles" />
          <p>
            {waiting
              ? m.files_pending_named({ name: file.name })
              : m.files_processing_named({ name: file.name })}
          </p>
          <ProgressBar
            className="w-full"
            showLabel
            tone={color}
            value={file.ingestPct ?? 0}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {file && fileIsIngesting(file.status) && file.url && (
        <div className="flex shrink-0 items-center gap-3 border-divider border-b bg-surface-hover-bg px-4 py-2">
          <p className="t-meta min-w-0 flex-1 truncate text-fg-secondary">
            {file.status === 'pending'
              ? m.files_pending_named({ name: file.name })
              : m.files_processing_named({ name: file.name })}
          </p>
          <ProgressBar
            className="w-28"
            tone={color}
            value={file.ingestPct ?? 0}
          />
        </div>
      )}
      {file && <FileNotIndexedBanner file={file} />}
      <div className="relative min-h-0 flex-1 overflow-auto">
        <FileViewer
          file={file ?? null}
          imageZoom={imageZoom}
          onDirtyChange={onViewerDirtyChange}
          onImageZoomChange={onImageZoomChange}
          page={page}
          regions={regions}
        />
      </div>
    </div>
  );
}
