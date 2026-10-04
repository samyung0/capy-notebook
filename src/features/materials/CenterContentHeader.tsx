import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { createStore, type StoreApi } from 'zustand';
import {
  useFile,
  useFlashcardSet,
  useMaterial,
  useMaterials,
  useQuiz,
  useWorkspace,
} from '@/api/hooks';
import type {
  AccessCapabilities,
  Chapter,
  Material,
  MaterialKind,
  MaterialRef,
  SourceFile,
  UserColor,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import {
  clampImageZoom,
  IMAGE_MAX_ZOOM,
  IMAGE_MIN_ZOOM,
  IMAGE_ZOOM_STEP,
  isImageFile,
  officeFormatOf,
} from '@/features/files/fileUtils';
import {
  type NoteEditorSaveState,
  type NoteEditorStatus,
  noteEditorStatusLabel,
} from '@/features/notes/editorMode';
import { ContentActions } from '@/features/workspace/ContentActions';
import {
  toFileActionTarget,
  toMaterialActionTarget,
} from '@/features/workspace/contentActionTarget';
import {
  OfflineStatus,
  WorkspaceStatusButton,
} from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { useOnlineStatus } from '@/lib/online';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { MaterialModeToggle } from './MaterialModeToggle';
import { type MaterialMode, materialModePolicy } from './modePolicy';
import type { OpenItem } from './openItem';

const STATUS_ICON = {
  connecting: 'cloudSync',
  error: 'cloudAlert',
  offline: 'cloudOff',
  reconnecting: 'cloudSync',
  saved: 'cloudCheck',
  synced: 'cloudSavingDone',
  syncing: 'cloudSync',
  unsaved: 'cloudAlert',
} satisfies Record<NoteEditorSaveState, IconName>;

/** The open editor's save status. A store rather than `CenterContent` state:
 * it changes on the first keystroke of every edit (Saved to Syncing), and as
 * state it re-rendered the whole header and the open note for one icon. */
export type EditorStatusStore = StoreApi<{
  report: (status: NoteEditorStatus | null) => void;
  status: NoteEditorStatus | null;
}>;

export const createEditorStatusStore = (): EditorStatusStore =>
  createStore((set) => ({
    report: (status) => set({ status }),
    status: null,
  }));

function EditorSaveStatus({
  layout,
  store,
}: {
  layout: 'office' | 'default';
  store: EditorStatusStore;
}) {
  // Subscribed in an effect rather than with `useStore`: an external-store
  // update renders synchronously, and the first one (Synced, from the room's
  // sync callback) made a near-limit note render twice on open.
  const [editorStatus, setEditorStatus] = useState(store.getState().status);
  useEffect(() => {
    setEditorStatus(store.getState().status);
    return store.subscribe((state) => setEditorStatus(state.status));
  }, [store]);
  const online = useOnlineStatus();
  const statusLabel = noteEditorStatusLabel(editorStatus);
  if (!(online && editorStatus && statusLabel)) return null;
  const failed =
    editorStatus.saveState === 'error' || editorStatus.saveState === 'unsaved';
  if (layout === 'office')
    return (
      <span
        className={cn(
          'ml-2 inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[0.8125rem] text-fg-muted',
          failed && 'text-solid-error'
        )}
        data-testid="editor-save-state"
        role="status"
      >
        <Icon
          className="size-[15px]"
          name={STATUS_ICON[editorStatus.saveState]}
        />
        {statusLabel}
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(
          'ml-1 inline-flex shrink-0 items-center rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-focus',
          failed && 'text-solid-error'
        )}
        data-testid="editor-save-state"
        render={<span role="status" />}
        tabIndex={0}
      >
        <Icon
          className="size-4 lg:size-5"
          name={STATUS_ICON[editorStatus.saveState]}
        />
        <span className="sr-only">{statusLabel}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{statusLabel}</TooltipContent>
    </Tooltip>
  );
}

function useHeader(
  item: OpenItem,
  workspaceId: string,
  standalone: boolean
): {
  file?: SourceFile;
  icon: FileIconName;
  title?: string;
  material?: Material | MaterialRef;
  materialCapabilities?: AccessCapabilities;
  materialKind?: MaterialKind;
  showImageZoom: boolean;
  modes?: readonly MaterialMode[];
  defaultMode?: MaterialMode;
} {
  const { data: fileData } = useFile(item.kind === 'file' ? item.id : null, {
    errorBoundary: false,
  });
  // Inside a workspace the list entry and the workspace's capabilities cover
  // everything the header shows. Reading the material itself here would pull
  // the whole document past the heavy-document gate, so the body is fetched
  // only when the list cannot answer: the standalone page, or a material the
  // list does not carry, which the gate cannot weigh either.
  const inWorkspace =
    item.kind === 'material' && !standalone && workspaceId !== '';
  const { data: list, isPending: listPending } = useMaterials(
    inWorkspace ? workspaceId : '',
    { errorBoundary: false }
  );
  const { data: workspace } = useWorkspace(inWorkspace ? workspaceId : '', {
    errorBoundary: false,
  });
  const listed = inWorkspace
    ? list?.find((entry) => entry.id === item.id)
    : undefined;
  const readBody =
    item.kind === 'material' && (!inWorkspace || (!listPending && !listed));
  const { data: materialData } = useMaterial(readBody ? item.id : null, {
    errorBoundary: false,
  });
  if (item.kind === 'file') {
    return {
      file: fileData,
      icon: fileData ? fileIconName(fileData) : '_file',
      showImageZoom: !!fileData && isImageFile(fileData),
      title: fileData?.name,
    };
  }
  const mt = listed ?? materialData;
  const capabilities = listed
    ? workspace?.capabilities
    : materialData?.capabilities;
  if (!mt || !capabilities) {
    return { icon: '_file', showImageZoom: false, title: mt?.title };
  }
  const kind = 'type' in mt ? mt.type : mt.kind;
  const policy = materialModePolicy(capabilities);
  return {
    defaultMode: policy.defaultMode,
    icon: materialIconName(kind),
    material: mt,
    materialCapabilities: capabilities,
    materialKind: kind,
    modes: policy.modes,
    showImageZoom: false,
    title: mt.title,
  };
}

function FlashcardSetPreviewActions({
  flashcardSetId,
}: {
  flashcardSetId: string;
}) {
  const { data: flashcardSetData, isLoading: flashcardSetIsLoading } =
    useFlashcardSet(flashcardSetId, {
      errorBoundary: false,
    });
  const navigate = useNavigate();
  const summary = flashcardSetData
    ? m.material_ref_cards({ count: flashcardSetData.cardCount })
    : flashcardSetIsLoading
      ? 'Loading flashcards…'
      : 'Flashcards';

  return (
    <div
      aria-label={m.material_flashcard_actions()}
      className="flex min-w-0 items-center gap-3"
      role="toolbar"
    >
      <span className="t-meta min-w-0 truncate text-fg-muted">{summary}</span>
      <Button
        iconRight="arrowRight"
        onClick={() =>
          navigate({
            params: { flashcardSetId },
            to: '/flashcards/$flashcardSetId',
          })
        }
        size="sm"
        variant="ghost-hover"
      >
        Study
      </Button>
    </div>
  );
}

function QuizPreviewActions({ quizId }: { quizId: string }) {
  const { data: quizData, isLoading: quizIsLoading } = useQuiz(quizId, {
    errorBoundary: false,
  });
  const navigate = useNavigate();
  const summary = quizData
    ? `${quizData.questions.length} question${quizData.questions.length === 1 ? '' : 's'}`
    : quizIsLoading
      ? 'Loading quiz details…'
      : 'Quiz';

  return (
    <div
      aria-label={m.material_quiz_actions()}
      className="flex min-w-0 items-center gap-3"
      role="toolbar"
    >
      <span className="t-meta min-w-0 truncate text-fg-muted">{summary}</span>
      <Button
        className="font-medium text-sm"
        iconRight="arrowRight"
        onClick={() =>
          navigate({ params: { quizId }, to: '/quizzes/$quizId/attempt' })
        }
        size="sm"
        variant="ghost-hover"
      >
        {m.quiz_start()}
      </Button>
    </div>
  );
}

function MaterialViewActions({
  materialId,
  kind,
}: {
  materialId: string;
  kind: MaterialKind;
}) {
  if (kind === 'quiz') return <QuizPreviewActions quizId={materialId} />;
  if (kind === 'flashcards')
    return <FlashcardSetPreviewActions flashcardSetId={materialId} />;
  return null;
}

export function Header({
  beforeFileDelete,
  chapters,
  color,
  item,
  imageZoom,
  onImageZoomChange,
  materialMode,
  onMaterialModeChange,
  isFullscreen,
  onDeleted,
  onToggleFullscreen,
  editorStatus,
  readOnly,
  workspaceId,
  leading,
  standalone = false,
  fileControls,
  fileActions,
  menuBar,
}: {
  standalone?: boolean;
  fileControls?: ReactNode;
  /** Office files: buttons the runtime adds before the mode toggle (Present). */
  fileActions?: ReactNode;
  /** Office files: where the runtime's menu bar renders, on the second row. */
  menuBar?: ReactNode;
  beforeFileDelete?: () => boolean;
  /** Workspace chrome drawn before the file: layout toggle and workspace menu. */
  leading?: ReactNode;
  chapters: Chapter[];
  color?: UserColor;
  item: OpenItem;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  materialMode: MaterialMode | null;
  onMaterialModeChange: (mode: MaterialMode) => void;
  isFullscreen: boolean;
  onDeleted: () => void;
  onToggleFullscreen: () => void;
  editorStatus: EditorStatusStore;
  readOnly: boolean;
  workspaceId: string;
}) {
  const {
    file,
    icon,
    material,
    materialCapabilities,
    title,
    materialKind,
    showImageZoom,
    modes,
    defaultMode,
  } = useHeader(item, workspaceId, standalone);
  const activeMode = readOnly
    ? 'view'
    : materialMode && modes?.includes(materialMode)
      ? materialMode
      : defaultMode;
  // Phones have no room to go fuller than the panel already is.
  const sm = useMediaQuery('(min-width: 640px)');
  const office = !!file && !!officeFormatOf(file);
  const name = (
    <>
      <FileIcon
        className="size-4 shrink-0 -translate-y-px md:size-5"
        name={icon}
      />
      <h2
        className={cn(
          'min-w-0 truncate',
          leading ? 't-body font-semibold' : 't-subtitle'
        )}
      >
        {title ?? '--'}
      </h2>
    </>
  );
  const right = (
    <>
      {item.kind === 'file' && office && fileActions}
      {item.kind === 'file' && fileControls}
      {item.kind === 'material' && activeMode === 'view' && materialKind && (
        <MaterialViewActions kind={materialKind} materialId={item.id} />
      )}
      {!readOnly && modes && modes.length > 1 && activeMode && (
        <MaterialModeToggle mode={activeMode} onChange={onMaterialModeChange} />
      )}
      {showImageZoom && (
        <>
          <ToolbarButton
            disabled={imageZoom <= IMAGE_MIN_ZOOM}
            label={m.material_zoom_out()}
            onClick={() =>
              onImageZoomChange(clampImageZoom(imageZoom - IMAGE_ZOOM_STEP))
            }
          >
            <Icon name="zoomOut" />
          </ToolbarButton>
          <ToolbarButton
            disabled={imageZoom >= IMAGE_MAX_ZOOM}
            label={m.material_zoom_in()}
            onClick={() =>
              onImageZoomChange(clampImageZoom(imageZoom + IMAGE_ZOOM_STEP))
            }
          >
            <Icon name="zoomIn" />
          </ToolbarButton>
        </>
      )}
      <ContentActions
        beforeDelete={file ? beforeFileDelete : undefined}
        chapters={chapters}
        color={color}
        content={
          file
            ? toFileActionTarget(file)
            : material
              ? toMaterialActionTarget(material)
              : undefined
        }
        display="menu"
        key={`${item.kind}:${item.id}`}
        leadingItems={
          sm
            ? [
                {
                  icon: isFullscreen ? 'minimize' : 'maximize',
                  label: isFullscreen
                    ? m.material_fullscreen_exit()
                    : m.material_fullscreen(),
                  onClick: onToggleFullscreen,
                },
              ]
            : []
        }
        menuTrigger={
          <ToolbarButton label={m.a11y_open_menu()}>
            <Icon name="moreVertical" />
          </ToolbarButton>
        }
        onDeleted={onDeleted}
        readOnly={
          readOnly ||
          (materialCapabilities ? !materialCapabilities.canEdit : false)
        }
        renameFieldLabel={m.files_file_name()}
        showMove={!standalone}
        workspaceId={workspaceId}
      />
    </>
  );
  // Office files: the top row carries the file, the second the runtime's menu
  // bar and the save status, both 24px under a 4px gap; the mode toggle and ⋮
  // sit centred on both, or on the top row below sm, where the menu bar takes
  // the full width.
  if (office)
    return (
      <div
        className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[24px_24px] gap-x-2 gap-y-0.5 border-divider border-b pt-1 pr-2 pl-4"
        data-layout="office"
        data-testid="content-header"
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-2',
            // The workspace chrome at the row's height; the workspace picker
            // (a dropdown trigger) as a slimmer pill.
            '[&_[data-slot=button]:not([data-variant])]:w-6 [&_[data-slot=button]]:h-6',
            '[&_[data-slot=dropdown-menu-trigger]]:h-6 [&_[data-slot=dropdown-menu-trigger]]:gap-1.5 [&_[data-slot=dropdown-menu-trigger]]:px-1.5'
          )}
        >
          {leading}
          <div className="-ml-2 flex min-w-0 items-center gap-2 sm:-ml-0.5 lg:ml-2">
            {name}
            <OfflineStatus />
            <WorkspaceStatusButton
              workspaceId={standalone ? '' : workspaceId}
            />
          </div>
        </div>
        <div className="col-span-2 row-start-2 flex min-w-0 items-center sm:col-span-1">
          {menuBar}
          <EditorSaveStatus layout="office" store={editorStatus} />
        </div>
        <div className="col-start-2 row-start-1 flex items-center gap-0 sm:row-span-2 max-sm:[&_[data-slot=button]]:size-6 max-sm:[&_[data-slot=dropdown-menu-trigger]]:size-6">
          {right}
        </div>
      </div>
    );
  return (
    <div
      className="flex h-14 items-center gap-2 border-divider border-b py-4 pr-2 pl-4"
      data-testid="content-header"
    >
      {leading}
      <div className="-ml-2 flex min-w-0 items-center gap-2 sm:-ml-0.5 lg:ml-2">
        <FileIcon
          className="size-4 shrink-0 -translate-y-px md:size-5"
          name={icon}
        />
        <h2
          className={cn(
            'min-w-0 flex-1 truncate',
            leading ? 't-body font-semibold' : 't-subtitle'
          )}
        >
          {title ?? '--'}
        </h2>
        <OfflineStatus />
        <EditorSaveStatus layout="default" store={editorStatus} />
        <WorkspaceStatusButton workspaceId={standalone ? '' : workspaceId} />
      </div>
      <div className="ml-auto flex items-center gap-0">{right}</div>
    </div>
  );
}
