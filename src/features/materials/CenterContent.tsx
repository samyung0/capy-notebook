import { lazy, Suspense, useEffect, useState } from 'react';
import { useFile, useMaterial } from '@/api/hooks';
import type { UserColor } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { IMAGE_MIN_ZOOM } from '@/features/files/fileUtils';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { Header } from './CenterContentHeader';
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
  item,
  readOnly = false,
  color,
}: {
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
}) {
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  const [materialMode, setMaterialMode] = useState<MaterialMode | null>(null);
  const [editorStatus, setEditorStatus] = useState<NoteEditorStatus | null>(
    null
  );
  const [collaborationActionsHost, setCollaborationActionsHost] =
    useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setMaterialMode(null);
    setEditorStatus(null);
  }, [item?.kind, item?.id]);

  const changeMaterialMode = (nextMode: MaterialMode) => {
    setEditorStatus(null);
    setMaterialMode(nextMode);
  };

  if (!item) {
    return <EmptyCenter />;
  }
  return (
    <>
      <Header
        collaborationActionsRef={setCollaborationActionsHost}
        editorStatus={editorStatus}
        imageZoom={imageZoom}
        item={item}
        materialMode={materialMode}
        onImageZoomChange={setImageZoom}
        onMaterialModeChange={changeMaterialMode}
      />
      <div className="relative min-h-0 flex-1 overflow-auto">
        {item.kind === 'material' && (
          <MaterialBody
            allowExternalAssets={!readOnly}
            collaborationActionsHost={collaborationActionsHost}
            materialId={item.id}
            mode={materialMode}
            onEditorStatusChange={setEditorStatus}
          />
        )}
        {item.kind === 'file' && (
          <FileBody
            color={color}
            fileId={item.id}
            imageZoom={imageZoom}
            onImageZoomChange={setImageZoom}
          />
        )}
      </div>
    </>
  );
}

function MaterialBody({
  materialId,
  mode,
  allowExternalAssets,
  onEditorStatusChange,
  collaborationActionsHost,
}: {
  materialId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  collaborationActionsHost: HTMLDivElement | null;
}) {
  const { data: material, isLoading, isError } = useMaterial(materialId);
  if (isLoading) {
    return <FileLoading />;
  }
  if (isError || !material) {
    return <FileError />;
  }
  const policy = materialModePolicy(material.kind, material.capabilities);
  const activeMode = resolveMaterialMode(mode, policy);

  return (
    <div className="h-full min-h-0">
      {activeMode === 'view' && (
        <div className="h-full min-h-0 overflow-auto">
          <Suspense fallback={<FileLoading />}>
            <MaterialPreview
              className="mx-auto max-w-[700px]"
              content={material.content}
            />
          </Suspense>
        </div>
      )}
      {isInteractiveMaterialMode(activeMode) && (
        <Suspense fallback={<FileLoading />}>
          <NoteEditor
            allowExternalAssets={allowExternalAssets}
            collaborationActionsHost={collaborationActionsHost}
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
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
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
    />
  );
}
