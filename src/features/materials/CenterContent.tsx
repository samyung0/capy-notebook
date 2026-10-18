import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { useFile } from '@/api/hooks';
import type { Chapter, Region, UserColor } from '@/api/types';
import { BannerStack, FileBanner } from '@/components/banners/FileBanner';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  FileError,
  FileLoading,
  FileNotIndexedBanner,
} from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import {
  EditorStatusContext,
  FileActionsTarget,
  FileHeaderTarget,
  FileMenuTarget,
  FileModeContext,
} from '@/features/files/fileModeContext';
import { fileIsIngesting, IMAGE_MIN_ZOOM } from '@/features/files/fileUtils';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import { handOverLiveNote } from '@/features/notes/liveNoteHandover';
import {
  OfflineStatus,
  WorkspaceStatusButton,
} from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/useMediaQuery';
import {
  createEditorStatusStore,
  EditorStatusStoreContext,
  FilesTitleButton,
  Header,
  type OneColumnChrome,
} from './CenterContentHeader';
import type { MaterialMode } from './modePolicy';
import { type OpenItem, readDocumentMode, saveDocumentMode } from './openItem';

/* Each body kind loads its own code: a file's page never loads the material
 * views or the empty workspace's cards. */
const MaterialBody = lazy(() =>
  import('./CenterContentMaterial').then((module) => ({
    default: module.MaterialBody,
  }))
);
const EmptyCenterBody = lazy(() =>
  import('./CenterContentEmpty').then((module) => ({
    default: module.EmptyCenterBody,
  }))
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
  onAddFile,
  onModeChange,
  onOpenSettings,
  requestedMode = null,
  workspaceId,
  leading,
  oneColumn,
  standalone = false,
}: {
  /** Below lg: the title opens Files and ⋮ carries the workspace actions. */
  oneColumn?: OneColumnChrome;
  standalone?: boolean;
  beforeFileDelete?: () => boolean;
  /** Workspace chrome drawn before the file name in the header. */
  leading?: ReactNode;
  chapters: Chapter[];
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
  onDeleted: () => void;
  onFileViewerDirtyChange?: (dirty: boolean) => void;
  requestedMode?: MaterialMode | null;
  onModeChange: (mode: MaterialMode) => void;
  /** Opens the add file dialog; an empty workspace shows it as a card. */
  onAddFile?: () => void;
  /** Opens workspace settings; shown as a quick action when no file is open. */
  onOpenSettings?: () => void;
  workspaceId: string;
}) {
  const [fileHeader, setFileHeader] = useState<HTMLSpanElement | null>(null);
  const [fileMenu, setFileMenu] = useState<HTMLSpanElement | null>(null);
  const [fileActions, setFileActions] = useState<HTMLSpanElement | null>(null);
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  const materialMode =
    requestedMode ?? (item ? readDocumentMode(item) : 'view');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editorStatus] = useState(createEditorStatusStore);
  // Stable: the store's own setter, so reporting never re-renders this pane.
  const setEditorStatus = editorStatus.getState().report;

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setEditorStatus(null);
    setIsFullscreen(false);
  }, [item?.kind, item?.id]);

  useEffect(() => {
    if (item && requestedMode) saveDocumentMode(item, requestedMode);
  }, [item?.kind, item?.id, requestedMode]);

  const changeMaterialMode = (nextMode: MaterialMode) => {
    setEditorStatus(null);
    if (item) saveDocumentMode(item, nextMode);
    // The open editor's live document goes into the cached material before
    // View renders, so View renders it once.
    if (nextMode === 'view' && item?.kind === 'material')
      handOverLiveNote(item.id);
    onModeChange(nextMode);
  };

  if (!item) {
    return (
      <EmptyCenter
        leading={leading}
        onAddFile={onAddFile}
        oneColumn={oneColumn}
        onOpenSettings={onOpenSettings}
        workspaceId={standalone ? '' : workspaceId}
      />
    );
  }
  return (
    <FileModeContext.Provider
      value={{ mode: materialMode, onChange: changeMaterialMode }}
    >
      <FileHeaderTarget.Provider value={fileHeader}>
        <FileMenuTarget.Provider value={fileMenu}>
          <FileActionsTarget.Provider value={fileActions}>
            <EditorStatusContext.Provider value={setEditorStatus}>
              <EditorStatusStoreContext.Provider value={editorStatus}>
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
                    fileActions={
                      <span
                        className="flex items-center"
                        ref={setFileActions}
                      />
                    }
                    fileControls={
                      <span className="flex items-center" ref={setFileHeader} />
                    }
                    imageZoom={imageZoom}
                    isFullscreen={isFullscreen}
                    item={item}
                    leading={leading}
                    materialMode={materialMode}
                    menuBar={
                      <span
                        className="flex min-w-0 items-center"
                        ref={setFileMenu}
                      />
                    }
                    onDeleted={onDeleted}
                    oneColumn={oneColumn}
                    onImageZoomChange={setImageZoom}
                    onMaterialModeChange={changeMaterialMode}
                    onToggleFullscreen={() =>
                      setIsFullscreen((value) => !value)
                    }
                    readOnly={readOnly}
                    standalone={standalone}
                    workspaceId={workspaceId}
                  />
                  {/* One strip at a time under the header: the newest shows. */}
                  <BannerStack key={item.id}>
                    <div
                      className={cn(
                        'relative min-h-0 flex-1',
                        item.kind === 'file'
                          ? 'flex flex-col overflow-hidden'
                          : 'overflow-auto'
                      )}
                    >
                      {item.kind === 'material' && (
                        <Suspense fallback={<FileLoading />}>
                          <MaterialBody
                            allowExternalAssets={!readOnly}
                            centerQuiz={!standalone}
                            key={item.id}
                            materialId={item.id}
                            mode={materialMode}
                            onEditorStatusChange={setEditorStatus}
                            readOnly={readOnly}
                            target={item.target}
                            workspaceId={workspaceId}
                          />
                        </Suspense>
                      )}
                      {item.kind === 'file' && (
                        <FileBody
                          citation={item.citation}
                          color={color}
                          fileId={item.id}
                          imageZoom={imageZoom}
                          key={item.id}
                          onImageZoomChange={setImageZoom}
                          onViewerDirtyChange={onFileViewerDirtyChange}
                          page={item.page}
                          regions={item.regions}
                        />
                      )}
                    </div>
                  </BannerStack>
                </div>
              </EditorStatusStoreContext.Provider>
            </EditorStatusContext.Provider>
          </FileActionsTarget.Provider>
        </FileMenuTarget.Provider>
      </FileHeaderTarget.Provider>
    </FileModeContext.Provider>
  );
}

/** No file open: the header row keeps the workspace picker, then the offline
 * and workspace status icons. No strip renders, since strips belong to a file. */
function EmptyCenter({
  leading,
  oneColumn,
  onAddFile,
  onOpenSettings,
  workspaceId,
}: {
  leading?: ReactNode;
  oneColumn?: OneColumnChrome;
  onAddFile?: () => void;
  onOpenSettings?: () => void;
  workspaceId: string;
}) {
  const sm = useMediaQuery('(min-width: 640px)');
  const menuItems = oneColumn
    ? [...oneColumn.addItems, ...oneColumn.settingsItems]
    : [];
  return (
    <>
      <div
        className="flex h-12 items-center gap-1 border-divider border-b pr-1 pl-2 sm:h-14 sm:gap-2 sm:px-4"
        data-slot="center-header"
      >
        {leading ?? (
          <>
            <Icon className="size-5.5" name="files" />
            <h2 className="t-subtitle translate-y-px truncate">--</h2>
          </>
        )}
        {oneColumn && (
          <h2 className="t-body min-w-0 font-semibold">
            <FilesTitleButton chrome={oneColumn}>
              <span className="min-w-0 truncate">
                {oneColumn.workspaceName}
              </span>
            </FilesTitleButton>
          </h2>
        )}
        {!(oneColumn && !sm) && (
          <>
            <OfflineStatus />
            <WorkspaceStatusButton workspaceId={workspaceId} />
          </>
        )}
        {menuItems.length > 0 && (
          <div className="ml-auto flex items-center">
            <Menu
              items={menuItems}
              trigger={
                <ToolbarButton label={m.a11y_open_menu()}>
                  <Icon name="moreVertical" />
                </ToolbarButton>
              }
            />
          </div>
        )}
      </div>
      <div className="grid flex-1 place-items-center p-4 sm:p-6">
        {/* Blank until its code and the recent items arrive. */}
        <Suspense fallback={null}>
          <EmptyCenterBody
            onAddFile={onAddFile}
            onOpenSettings={onOpenSettings}
            workspaceId={workspaceId}
          />
        </Suspense>
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
  citation,
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  onViewerDirtyChange?: (dirty: boolean) => void;
  page?: number;
  regions?: Region[];
  citation?: OfficeCitation;
}) {
  const {
    data: file,
    isLoading,
    isError,
  } = useFile(fileId, {
    errorBoundary: false,
  });
  if (isLoading) return <FileLoading />;
  if (!file && isError) return <FileError />;
  if (file && fileIsIngesting(file.status) && !file.hasBytes) {
    const waiting = file.status === 'pending';
    return (
      <div className="grid h-full place-items-center">
        <div className="flex w-64 -translate-y-1/2 flex-col items-center gap-3">
          <Icon className="non-scaling-svg size-7" name="sparkles" />
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
      {file && fileIsIngesting(file.status) && file.hasBytes && (
        <FileBanner
          message={
            file.status === 'pending'
              ? m.files_pending_named({ name: file.name })
              : m.files_processing_named({ name: file.name })
          }
        />
      )}
      {file && <FileNotIndexedBanner file={file} />}
      <div className="relative min-h-0 flex-1 overflow-auto">
        <FileViewer
          citation={citation}
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
