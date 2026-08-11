import { lazy, Suspense, useEffect, useState } from 'react';
import { isMaterialContentUnreadable } from '@/api/client';
import { useFile, useMaterial, useMaterials } from '@/api/hooks';
import type { Chapter, UserColor } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { IMAGE_MIN_ZOOM } from '@/features/files/fileUtils';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
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
  chapters,
  item,
  readOnly = false,
  color,
  onDeleted,
  workspaceId,
}: {
  chapters: Chapter[];
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
  onDeleted: () => void;
  workspaceId: string;
}) {
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  const [materialMode, setMaterialMode] = useState<MaterialMode | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editorStatus, setEditorStatus] = useState<NoteEditorStatus | null>(
    null
  );

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setMaterialMode(null);
    setEditorStatus(null);
    setIsFullscreen(false);
  }, [item?.kind, item?.id]);

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
      <div className="relative min-h-0 flex-1 overflow-auto">
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
            page={item.page}
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
  const { data: material, error, isLoading } = useMaterial(materialId);
  if (isLoading) {
    return <FileLoading />;
  }
  if (error || !material) {
    return isMaterialContentUnreadable(error) ? (
      <FileError
        message="Its stored content could not be decoded, so nothing is shown rather than an empty page. Support can recover it from an earlier version."
        title="This note could not be loaded"
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
            <MaterialPreview content={material.content} />
          </Suspense>
        </div>
      )}
      {isInteractiveMaterialMode(activeMode) && (
        <Suspense fallback={<FileLoading />}>
          <NoteEditor
            allowExternalAssets={allowExternalAssets}
            key={`${materialId}:${activeMode}`}
            materialId={materialId}
            mode={activeMode}
            onEditorStatusChange={onEditorStatusChange}
          />
        </Suspense>
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
          <p>Select a file or material to view it here.</p>
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
  page,
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  page?: number;
}) {
  const { data: file, isLoading, isError } = useFile(fileId);
  if (isLoading) return <FileLoading />;
  if (!isLoading && isError) return <FileError />;
  if (file?.status === 'processing') {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex w-64 -translate-y-1/2 flex-col items-center gap-3">
          <Icon className="size-7" name="sparkles" />
          <p>Processing {file.name}…</p>
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
  if (file?.status === 'failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 font-semibold text-solid-error">
        <p className="mt-3">Unable to process file {file.name}.</p>
      </div>
    );
  }
  return (
    <FileViewer
      file={file ?? null}
      imageZoom={imageZoom}
      onImageZoomChange={onImageZoomChange}
      page={page}
    />
  );
}
