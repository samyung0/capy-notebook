import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useEffect, useState } from 'react';
import { createStore, type StoreApi } from 'zustand';
import {
  materialQuery,
  useFile,
  useMaterials,
  useWorkspace,
} from '@/api/hooks';
import type {
  AccessCapabilities,
  Chapter,
  Material,
  MaterialRef,
  SourceFile,
  UserColor,
} from '@/api/types';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import type { PresenceStore } from '@/features/collaboration/presence';
import { useSlowedLine } from '@/features/collaboration/SlowedOpen';
import {
  clampImageZoom,
  fileCanClone,
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
import { useStudyActions, useStudyStates } from '@/features/study/studyItems';
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
import { MaterialShareDialog } from './MaterialShareDialog';
import { type MaterialMode, materialModePolicy } from './modePolicy';
import type { OpenItem } from './openItem';
import { RoomPresence } from './RoomPresence';

const STATUS_ICON = {
  connecting: 'cloudSync',
  error: 'cloudAlert',
  offline: 'cloudOff',
  reconnecting: 'cloudSync',
  saved: 'CloudIcon',
  synced: 'CloudIcon',
  syncing: 'cloudSync',
  unsaved: 'cloudAlert',
} satisfies Record<NoteEditorSaveState, IconName>;

/** The workspace below lg has no side panels: the title opens Files from the
 * top, and ⋮ carries the workspace actions the panels held. */
export interface OneColumnChrome {
  /** Add file and Add chapter, first in ⋮. */
  addItems: MenuItem[];
  filesOpen: boolean;
  onOpenFiles: () => void;
  /** Workspace settings, before Delete in ⋮. */
  settingsItems: MenuItem[];
  /** The title when no file is open. */
  workspaceName: string;
}

/** The title as the button that opens the Files dropdown, chevron after it. */
export function FilesTitleButton({
  chrome,
  children,
}: {
  chrome: OneColumnChrome;
  children: ReactNode;
}) {
  return (
    <button
      aria-expanded={chrome.filesOpen}
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-button text-left sm:gap-2"
      onClick={chrome.onOpenFiles}
      type="button"
    >
      {children}
      <Icon
        className={cn(
          'shrink-0 text-fg-muted transition-transform duration-(--motion-duration-fast) ease-(--motion-ease-in-out)',
          chrome.filesOpen && 'rotate-180'
        )}
        name="chevronDown"
        size={16}
      />
    </button>
  );
}

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

/** The open editor's save status store, for an editor's own dialogs (a
 * note's Mermaid source dialog shows the note's status in its footer). */
export const EditorStatusStoreContext = createContext<EditorStatusStore | null>(
  null
);

/** The open editor's save status. In the header, an icon beside the file's
 * name on the top row at every width (Epo 2026-10-20), its label in the
 * tooltip, held open with the slowed line while an open waits on the open
 * budget; `labelled` (a dialog's footer) writes the label beside the icon,
 * and `labelFromMd` (every file's header, Epo 2026-10-22) from md up. */
export function EditorSaveStatus({
  labelled = false,
  labelFromMd = false,
  store,
}: {
  labelled?: boolean;
  labelFromMd?: boolean;
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
  // A slowed open (a note's reconnect, an Office or text file's open) says
  // why under the indicator, its tooltip held open after 5 s (Epo
  // 2026-10-20).
  const slowedLine = useSlowedLine(!!editorStatus?.slowed);
  const [hovered, setHovered] = useState(false);
  const statusLabel = noteEditorStatusLabel(editorStatus);
  if (!(online && editorStatus && statusLabel)) return null;
  const failed =
    editorStatus.saveState === 'error' || editorStatus.saveState === 'unsaved';
  if (labelled)
    return (
      <span
        className={cn(
          'ml-2 inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[0.8125rem] text-fg-muted',
          failed && 'text-solid-error'
        )}
        data-save-state={editorStatus.saveState}
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
    <Tooltip onOpenChange={setHovered} open={hovered || slowedLine}>
      <TooltipTrigger
        className={cn(
          'ml-1 inline-flex shrink-0 items-center rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-action',
          failed && 'text-solid-error'
        )}
        data-save-state={editorStatus.saveState}
        data-testid="editor-save-state"
        render={<span role="status" />}
        tabIndex={0}
      >
        <Icon
          className="size-4 sm:size-4.5"
          name={STATUS_ICON[editorStatus.saveState]}
        />
        <span
          className={cn(
            'sr-only',
            labelFromMd &&
              'md:not-sr-only md:ml-1 md:whitespace-nowrap md:text-[0.8125rem]',
            labelFromMd && !failed && 'md:text-fg-muted'
          )}
          data-testid="editor-save-label"
        >
          {statusLabel}
        </span>
        {slowedLine && (
          <span className="sr-only">{m.editor_open_slowed()}</span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {slowedLine ? m.editor_open_slowed() : statusLabel}
      </TooltipContent>
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
  /** Members and editors copy a workspace's items; any reader a standalone
   * one. An embedded row or an unprocessed file is never offered. */
  canClone: boolean;
  material?: Material | MaterialRef;
  materialCapabilities?: AccessCapabilities;
  showImageZoom: boolean;
  modes?: readonly MaterialMode[];
  defaultMode?: MaterialMode;
} {
  const { data: fileData } = useFile(item.kind === 'file' ? item.id : null, {
    errorBoundary: false,
  });
  // Inside a workspace the list entry and the workspace's capabilities cover
  // what the header shows until the body opens. Reading the material itself
  // here would pull the whole document past the heavy-document gate, so the
  // body is fetched only when the list cannot answer: the standalone page, or
  // a material the list does not carry, which the gate cannot weigh either.
  const inWorkspace =
    item.kind === 'material' && !standalone && workspaceId !== '';
  const { data: list, isPending: listPending } = useMaterials(
    inWorkspace ? workspaceId : '',
    { errorBoundary: false }
  );
  // Files always sit in a workspace; its canClone gates their Clone too.
  const { data: workspace } = useWorkspace(standalone ? '' : workspaceId, {
    errorBoundary: false,
  });
  const listed = inWorkspace
    ? list?.find((entry) => entry.id === item.id)
    : undefined;
  const readBody =
    item.kind === 'material' && (!inWorkspace || (!listPending && !listed));
  // Otherwise the body the pane opened is read from the cache: Edit is per
  // item (its payer's storage and lifecycle, uploader pays), which the
  // workspace's capabilities cannot say.
  const { data: materialData } = useQuery({
    ...materialQuery(item.kind === 'material' ? item.id : null),
    enabled: readBody,
    meta: { errorBoundary: false },
  });
  if (item.kind === 'file') {
    return {
      canClone: !!fileData && fileCanClone(fileData) && !!workspace?.canClone,
      file: fileData,
      icon: fileData ? fileIconName(fileData) : '_file',
      showImageZoom: !!fileData && isImageFile(fileData),
      title: fileData?.name,
    };
  }
  const mt = listed ?? materialData;
  const capabilities =
    materialData?.capabilities ??
    (listed ? workspace?.capabilities : undefined);
  if (!mt || !capabilities) {
    return {
      canClone: false,
      icon: '_file',
      showImageZoom: false,
      title: mt?.title,
    };
  }
  const kind = 'type' in mt ? mt.type : mt.kind;
  const policy = materialModePolicy(capabilities);
  const embedded = 'parentMaterialId' in mt && !!mt.parentMaterialId;
  return {
    canClone:
      !embedded &&
      (standalone
        ? !('workspaceId' in mt && mt.workspaceId)
        : !!workspace?.canClone),
    defaultMode: policy.defaultMode,
    icon: materialIconName(kind),
    material: mt,
    materialCapabilities: capabilities,
    modes: policy.modes,
    showImageZoom: false,
    title: mt.title,
  };
}

/** Mark as read, right of the view/edit toggle: an open book with a check, a
 * closed one in the marks' green once read; clicking again marks it unread. */
function ReadToggle({
  item,
  workspaceId,
}: {
  item: OpenItem;
  workspaceId: string;
}) {
  const { enabled, states } = useStudyStates(workspaceId);
  const { set } = useStudyActions(workspaceId);
  if (!enabled) return null;
  const done = states.get(item.id) === 'done';
  return (
    <ToolbarButton
      label={done ? m.study_mark_unread() : m.study_mark_read()}
      onClick={() =>
        set({ id: item.id, kind: item.kind }, done ? null : 'done')
      }
    >
      <Icon
        className={cn(done && 'text-tint-success-fg')}
        name={done ? 'bookCheck' : 'bookOpenCheck'}
      />
    </ToolbarButton>
  );
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
  trailing,
  standalone = false,
  fileControls,
  fileActions,
  menuBar,
  menuShown,
  oneColumn,
  presence,
}: {
  oneColumn?: OneColumnChrome;
  standalone?: boolean;
  fileControls?: ReactNode;
  /** Office files: buttons the runtime adds before the mode toggle (Present). */
  fileActions?: ReactNode;
  /** Office files: where the runtime's menu bar renders, on the second row. */
  menuBar?: ReactNode;
  /** Office files: the menu bar arrived (the file is visible), so the
   * header has its second row; one row until then (Epo 2026-10-20). */
  menuShown: boolean;
  /** The open room's other editors, shown as the avatar group. */
  presence: PresenceStore;
  beforeFileDelete?: () => boolean;
  /** Workspace chrome drawn before the file: layout toggle and workspace menu. */
  leading?: ReactNode;
  /** Workspace chrome at the header's right end: the right panel toggle. */
  trailing?: ReactNode;
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
    canClone,
    file,
    icon,
    material,
    materialCapabilities,
    title,
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
  const { enabled: studying, states: studyStates } = useStudyStates(
    standalone ? '' : workspaceId
  );
  const { menuItems: studyMenu } = useStudyActions(workspaceId);
  const office = !!file && !!officeFormatOf(file);
  // A standalone material's owner shares it from here as from its card.
  const shareable =
    material && 'isOwner' in material && material.isOwner && !readOnly
      ? material
      : undefined;
  const [sharing, setSharing] = useState(false);
  // Phones drop the read toggle and workspace status for the title's chevron.
  const compact = !!oneColumn && !sm;
  const fileIcon = (
    <FileIcon className="size-4 shrink-0 md:size-5" name={icon} />
  );
  const nameClassName = cn(
    'min-w-0 truncate',
    leading ? 't-body font-semibold' : 't-subtitle'
  );
  const name = oneColumn ? (
    <h2 className="min-w-0">
      <FilesTitleButton chrome={oneColumn}>
        {fileIcon}
        <span className={nameClassName}>{title ?? '--'}</span>
      </FilesTitleButton>
    </h2>
  ) : (
    <>
      {fileIcon}
      <h2 className={nameClassName}>{title ?? '--'}</h2>
    </>
  );
  const right = (
    <>
      <RoomPresence store={presence} />
      {/* A live item's Undo and Redo portal here in Edit (live-items D5). */}
      {(item.kind === 'material' || office) && fileActions}
      {item.kind === 'file' && fileControls}
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
    </>
  );
  // Mark as read and the file's ⋮ follow its name, the status icons after
  // them; phones drop the read toggle and keep ⋮ at the row's end.
  const menu = (
    <div className="flex items-center gap-0">
      {!(standalone || compact) && (
        <ReadToggle item={item} workspaceId={workspaceId} />
      )}
      <ContentActions
        beforeDelete={file ? beforeFileDelete : undefined}
        beforeDeleteItems={oneColumn?.settingsItems}
        canClone={canClone}
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
        leadingItems={[
          ...(oneColumn?.addItems ?? []),
          ...(studying && !standalone
            ? studyMenu(
                { id: item.id, kind: item.kind },
                studyStates.get(item.id)
              )
            : []),
          ...(sm
            ? [
                {
                  icon: isFullscreen ? 'minimize' : 'maximize',
                  label: isFullscreen
                    ? m.material_fullscreen_exit()
                    : m.material_fullscreen(),
                  onClick: onToggleFullscreen,
                } satisfies MenuItem,
              ]
            : []),
        ]}
        menuTrigger={
          <ToolbarButton label={m.a11y_open_menu()}>
            <Icon name="moreVertical" />
          </ToolbarButton>
        }
        onDeleted={onDeleted}
        onShare={shareable?.sharePath ? () => setSharing(true) : undefined}
        readOnly={
          readOnly ||
          (materialCapabilities ? !materialCapabilities.canEdit : false)
        }
        renameFieldLabel={m.files_file_name()}
        showMove={!standalone}
        workspaceId={workspaceId}
      />
      {sharing && shareable && (
        <MaterialShareDialog
          material={shareable}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
  // The save status sits beside the name on the top row at every width (Epo
  // 2026-10-20); the offline icon stands in for it while offline. Outside
  // Office its label shows beside it from md up (Epo 2026-10-22).
  const status = (
    <>
      <OfflineStatus />
      <EditorSaveStatus labelFromMd store={editorStatus} />
      {!compact && <WorkspaceStatusButton />}
    </>
  );
  // Office files: the top row carries the file, its ⋮ and its status, the
  // second the runtime's menu bar once it loaded (one row until then), both
  // 24px under a 4px gap; the mode toggle sits centred on both, or on the top
  // row below sm, where the menu bar takes the full width. The menu bar's
  // slot stays mounted while hidden: the runtime portals into it.
  if (office)
    return (
      <div
        className={cn(
          'grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 border-divider border-b pr-2',
          menuShown
            ? 'h-14 grid-rows-[24px_24px] gap-y-0.5 pt-1'
            : 'h-12 items-center sm:h-14',
          // Workspace buttons at the left edge (24px here, the right's are
          // full size) sit as far in as the right's.
          leading ? 'pl-3' : 'pl-4'
        )}
        data-layout="office"
        data-rows={menuShown ? 2 : 1}
        data-testid="content-header"
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-2',
            // The workspace chrome at the row's height; the workspace picker
            // (a dropdown trigger) as a slimmer pill.
            '[&_[data-slot=button]:not([data-variant])]:w-6 [&_[data-slot=button]]:h-6',
            '[&_[data-slot=dropdown-menu-trigger]]:h-6 [&_[data-slot=dropdown-menu-trigger]]:gap-1.5 [&_[data-slot=dropdown-menu-trigger]]:px-2'
          )}
        >
          {leading}
          <div
            className={cn(
              '-ml-2 flex min-w-0 items-center gap-2 sm:-ml-0.5',
              // Workspace buttons before it keep the buttons' narrow gaps.
              !leading && 'lg:ml-2'
            )}
          >
            {name}
            {!compact && menu}
            {status}
          </div>
        </div>
        <div
          className={cn(
            'col-span-2 row-start-2 flex min-w-0 items-center sm:col-span-1',
            !menuShown && 'hidden'
          )}
        >
          {menuBar}
        </div>
        <div
          className={cn(
            'col-start-2 row-start-1 flex items-center gap-0 max-sm:[&_[data-slot=button]]:size-7.5 max-sm:[&_[data-slot=dropdown-menu-trigger]]:size-7.5',
            menuShown && 'sm:row-span-2'
          )}
        >
          {right}
          {compact && menu}
          {trailing}
        </div>
      </div>
    );
  return (
    <div
      className={cn(
        'flex h-12 items-center gap-1 border-divider border-b pr-1 sm:h-14 sm:gap-2 sm:pr-2',
        // Workspace buttons at the left edge sit as far in as the right's.
        leading ? 'pl-1 sm:pl-2' : 'pl-2 sm:pl-4'
      )}
      data-testid="content-header"
    >
      {leading}
      <div
        className={cn(
          '-ml-0.5 flex min-w-0 items-center gap-1.5 sm:gap-2',
          // Workspace buttons before it keep the buttons' narrow gaps.
          !leading && 'lg:ml-2'
        )}
      >
        {oneColumn ? (
          name
        ) : (
          <>
            {fileIcon}
            <h2 className={cn(nameClassName, 'flex-1')}>{title ?? '--'}</h2>
          </>
        )}
        {!compact && menu}
        {status}
      </div>
      <div className="ml-auto flex items-center gap-0">
        {right}
        {compact && menu}
        {trailing}
      </div>
    </div>
  );
}
