import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { createContext, type ReactNode, useEffect, useState } from 'react';
import { createStore, type StoreApi } from 'zustand';
import { deletedItemOf, qk } from '@/api/client';
import {
  materialQuery,
  useFile,
  useFiles,
  useMaterials,
  useWorkspace,
} from '@/api/hooks';
import type {
  AccessCapabilities,
  Material,
  MaterialRef,
  SourceFile,
  Topic,
  UserColor,
} from '@/api/types';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Spinner } from '@/components/ui/feedback';
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
  fileCanMoveTo,
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
import { HiddenChip } from '@/features/workspace/HiddenChip';
import { useToggleHidden } from '@/features/workspace/hiddenFromMembers';
import {
  OfflineStatus,
  WorkspaceStatusButton,
} from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { useOnlineStatus } from '@/lib/online';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { MaterialShareDialog } from './MaterialShareDialog';
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
} satisfies Record<
  Exclude<NoteEditorSaveState, 'opening' | 'syncing-draft'>,
  IconName
>;

/** The status's mark: a spinner while a copy waits for its first sync or a
 * draft is on its way (Epo 2026-11-04), else its cloud. */
function StatusIcon({ state }: { state: NoteEditorSaveState }) {
  if (state === 'opening' || state === 'syncing-draft')
    return <Spinner className="size-4.5" />;
  return <Icon className="size-4.5" name={STATUS_ICON[state]} />;
}

/* The header's labels follow its width. A size container breaks WebKit's
   scroll anchoring for a reader while blocks are added above (Q393), so
   WebKit browsers (Safari and every iOS browser, all of which report Apple's
   vendor) skip `@container/header` and measure the header instead:
   `data-wide` at 42rem (`@2xl`), which the label variants also read. */
const WEBKIT =
  typeof navigator !== 'undefined' &&
  navigator.vendor === 'Apple Computer, Inc.';

function measureHeader(header: HTMLDivElement | null) {
  if (!(WEBKIT && header)) return;
  const rem = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize
  );
  const observer = new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    header.toggleAttribute('data-wide', width >= 42 * rem);
  });
  observer.observe(header);
  return () => observer.disconnect();
}

/** The workspace below lg has no side panels: ⋮ carries the workspace actions
 * the panels held; Files is its own page (Epo 2026-11-14). */
export interface OneColumnChrome {
  /** Add file and Add topic, first in ⋮. */
  addItems: MenuItem[];
  /** Workspace settings, before Delete in ⋮. */
  settingsItems: MenuItem[];
  /** The title when no file is open, after the workspace's icon. */
  workspaceIconId: string;
  workspaceName: string;
}

/** The one-column title: an icon and a name 10px apart, padded as the menu
 * buttons beside it. */
export function OneColumnTitle({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-2.5 px-1 py-1">
      {children}
    </span>
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
 * and `labelWhenWide` (every file's header, Epo 2026-10-22) once the header
 * is 42rem wide (36rem until Epo 2026-11-16, tight beside the Hidden chip),
 * measured on the header so a dragged panel drops it too. */
export function EditorSaveStatus({
  labelled = false,
  labelWhenWide = false,
  store,
}: {
  labelled?: boolean;
  labelWhenWide?: boolean;
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
  const opening = editorStatus.saveState === 'opening';
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
        {/* Lifted 1px to Fustat's cap band, level with the label. */}
        <StatusIcon state={editorStatus.saveState} />
        {opening ? <span className="sr-only">{statusLabel}</span> : statusLabel}
      </span>
    );
  return (
    <Tooltip onOpenChange={setHovered} open={hovered || slowedLine}>
      <TooltipTrigger
        className={cn(
          'inline-flex size-(--toolbar-button) shrink-0 items-center justify-center rounded-button outline-none focus-visible:ring-2 focus-visible:ring-action',
          // With its label the button grows to fit it rather than spilling
          // the icon over the ⋮ before it.
          labelWhenWide &&
            '@2xl/header:w-auto @2xl/header:px-1.5 group-data-wide/header:w-auto group-data-wide/header:px-1.5',
          failed && 'text-solid-error'
        )}
        data-save-state={editorStatus.saveState}
        data-testid="editor-save-state"
        render={<span role="status" />}
        tabIndex={0}
      >
        {/* Unlifted, a touch below the ⋮: the cloud's glyph leaves room
            under its base, so its ink centre reads high. */}
        <StatusIcon state={editorStatus.saveState} />
        <span
          className={cn(
            'sr-only',
            labelWhenWide &&
              !opening &&
              // Dropped 1px with the cloud.
              't-meta @2xl/header:not-sr-only @2xl/header:ml-2 translate-y-[1px] @2xl/header:whitespace-nowrap group-data-wide/header:not-sr-only group-data-wide/header:ml-2 group-data-wide/header:whitespace-nowrap'
          )}
        >
          {statusLabel}
        </span>
        {slowedLine && (
          <span className="sr-only">{m.editor_open_slowed()}</span>
        )}
      </TooltipTrigger>
      {/* Opening has no words but the slowed line. */}
      {(slowedLine || !opening) && (
        <TooltipContent side="bottom">
          {slowedLine ? m.editor_open_slowed() : statusLabel}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

function useHeader(
  item: OpenItem,
  workspaceId: string,
  standalone: boolean,
  trashed: boolean
): {
  /** Deleted while open (Q39): its read answers `item_deleted`, or trashed on
   * a page not opened from the Trash. */
  deleted: boolean;
  file?: SourceFile;
  icon: FileIconName;
  title?: string;
  /** Members and editors copy a workspace's items; any reader a standalone
   * one. An embedded row or an unprocessed file is never offered. */
  canClone: boolean;
  /** Move to… (fileCanMoveTo); the standalone page reads no workspace, so
   * there only the file's payer moves it. */
  canMoveTo?: boolean;
  material?: Material | MaterialRef;
  materialCapabilities?: AccessCapabilities;
  showImageZoom: boolean;
} {
  const { data: fileData, error: fileError } = useFile(
    item.kind === 'file' ? item.id : null,
    { errorBoundary: false }
  );
  // A file its workspace's list no longer carries (hidden from this person,
  // their access gone) is read again, as a material the list drops is read
  // (`readBody`): a file with no room open hears of it from nothing else, and
  // a refused read shows it unavailable.
  const listsFile =
    item.kind === 'file' && !standalone && !trashed && workspaceId !== '';
  const { data: files } = useFiles(listsFile ? workspaceId : '', {
    errorBoundary: false,
  });
  const unlistedFile =
    listsFile && !!files && !files.some((row) => row.id === item.id);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (unlistedFile)
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: qk.file(item.id),
      });
  }, [unlistedFile, item.id, queryClient]);
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
  // A workspace's canClone gates its files' Clone too; a standalone file is
  // its owner's, who may always copy it.
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
  const { data: materialData, error: materialError } = useQuery({
    ...materialQuery(item.kind === 'material' ? item.id : null),
    enabled: readBody,
    meta: { errorBoundary: false },
  });
  if (item.kind === 'file') {
    return {
      // One opened from the Trash only reads until restored.
      canClone:
        !!fileData &&
        !fileData.trash &&
        fileCanClone(fileData) &&
        (!fileData.workspaceId || !!workspace?.canClone),
      canMoveTo:
        !!fileData && !fileData.trash && fileCanMoveTo(fileData, workspace),
      deleted: !!deletedItemOf(fileError) || (!trashed && !!fileData?.trash),
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
  const deleted =
    !!deletedItemOf(materialError) || (!trashed && !!materialData?.trash);
  if (!mt || !capabilities) {
    return {
      canClone: false,
      deleted,
      icon: '_file',
      showImageZoom: false,
      title: mt?.title,
    };
  }
  const embedded = 'parentMaterialId' in mt && !!mt.parentMaterialId;
  return {
    canClone:
      !embedded &&
      !materialData?.trash &&
      (standalone
        ? !('workspaceId' in mt && mt.workspaceId)
        : !!workspace?.canClone),
    deleted,
    icon: materialIconName(mt.kind),
    material: mt,
    materialCapabilities: capabilities,
    showImageZoom: false,
    title: mt.title,
  };
}

export function Header({
  topics,
  color,
  item,
  imageZoom,
  onImageZoomChange,
  isFullscreen,
  deletedDownloads = [],
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
  menuShown,
  oneColumn,
  phoneItems = [],
  presence,
  trashed = false,
}: {
  oneColumn?: OneColumnChrome;
  /** Opened from the Trash: its trashed read is what shows. */
  trashed?: boolean;
  /** Deleted while its page shows its unsent edits (Q39): ⋮'s downloads,
   * made from what the page shows (Epo 2026-11-20). */
  deletedDownloads?: MenuItem[];
  /** The open file's buttons a phone has no room for, first in ⋮ there
   * (Preview, Epo 2026-11-16; `usePhoneMenuItem`). */
  phoneItems?: MenuItem[];
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
  /** Workspace chrome drawn before the file: layout toggle and workspace menu. */
  leading?: ReactNode;
  topics: Topic[];
  color?: UserColor;
  item: OpenItem;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  isFullscreen: boolean;
  onDeleted: () => void;
  onToggleFullscreen: () => void;
  editorStatus: EditorStatusStore;
  readOnly: boolean;
  workspaceId: string;
}) {
  const {
    canClone,
    canMoveTo,
    deleted,
    file,
    icon,
    material,
    materialCapabilities,
    title,
    showImageZoom,
  } = useHeader(item, workspaceId, standalone, trashed);
  const navigate = useNavigate();
  // Phones have no room to go fuller than the panel already is.
  const sm = useMediaQuery('(min-width: 640px)');
  const office = !!file && !!officeFormatOf(file);
  // A standalone material's owner shares it from here as from its card.
  const shareable =
    material &&
    'isOwner' in material &&
    material.isOwner &&
    !(readOnly || deleted)
      ? material
      : undefined;
  const [sharing, setSharing] = useState(false);
  // Phones drop the read toggle and workspace status for the title's chevron.
  const compact = !!oneColumn && !sm;
  const fileIcon = (
    <FileIcon
      className="size-4.5 shrink-0 -translate-y-px md:size-5"
      name={icon}
    />
  );
  const nameClassName = cn(
    'min-w-0 truncate',
    leading ? 't-body font-semibold' : 't-subtitle'
  );
  // Owners and editors who may change the item share a hidden one with
  // members here as from the ⋮ menu; viewers never see a hidden item.
  const itemReadOnly =
    readOnly || (materialCapabilities ? !materialCapabilities.canEdit : false);
  const { dialog: shareDialog, toggle: toggleHidden } =
    useToggleHidden(workspaceId);
  // A graded quiz's own quiz is its assignment's: held from members always,
  // never moved, cloned or trashed on its own.
  const owned =
    !!material && 'assignmentId' in material && !!material.assignmentId;
  const canHide = !(itemReadOnly || deleted) && !!workspaceId && !owned;
  // Only a hidden item says so (Epo 2026-11-16): a visible one shows nothing,
  // and the ⋮ menu's "Shared with members" switch hides it.
  const hiddenChip = (file?.hidden || material?.hidden) && (
    <>
      <HiddenChip
        onShow={
          canHide
            ? () => toggleHidden({ id: item.id, type: item.kind }, false)
            : undefined
        }
        // The first hidden quiz says what Hidden means (Epo 2026-11-20).
        tip={material?.kind === 'quiz'}
      />
      {shareDialog}
    </>
  );
  const name = oneColumn ? (
    <>
      {/* Never narrower than its icon and padding: a squeezed name truncates
          to nothing, and the Hidden chip would cover the icon. */}
      <h2 className="min-w-7">
        <OneColumnTitle>
          {fileIcon}
          <span className={nameClassName}>{title ?? '--'}</span>
        </OneColumnTitle>
      </h2>
      {hiddenChip}
    </>
  ) : (
    <>
      {fileIcon}
      <h2 className={nameClassName}>{title ?? '--'}</h2>
      {hiddenChip}
    </>
  );
  const right = (
    <>
      <RoomPresence store={presence} />
      {/* A live item's Undo and Redo portal here in Edit (live-items D5). */}
      {(item.kind === 'material' || office) && fileActions}
      {item.kind === 'file' && fileControls}
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
  // The file's ⋮ ends the row at every width (Epo 2026-11-16), after the
  // file's own buttons, in the toolbar's square box like Undo and Redo (a
  // 24px-wide box read as squished in its focus ring, Epo 2026-11-20); phones,
  // which have no Preview there, pull their 30px box 4px in.
  const menu = owned ? null : (
    <div className="flex items-center gap-0 max-sm:-ml-1">
      <ContentActions
        beforeDeleteItems={oneColumn?.settingsItems}
        canClone={canClone}
        canMoveTo={canMoveTo}
        color={color}
        content={
          file
            ? toFileActionTarget(file)
            : material
              ? toMaterialActionTarget(material)
              : undefined
        }
        // Deleted (Q39): nothing of the item's own that asks the server it is
        // gone from (rename, move, share, clone, its download, delete);
        // Properties from its last read and the page's own downloads stay
        // (Epo 2026-11-20).
        deletedDownloads={deleted ? deletedDownloads : undefined}
        display="menu"
        key={`${item.kind}:${item.id}`}
        leadingItems={[
          ...(sm ? [] : phoneItems),
          ...(oneColumn?.addItems ?? []),
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
        // The open file follows itself into its new workspace.
        onMoved={(moved) =>
          void navigate({
            params: { workspaceId: moved.workspaceId },
            replace: true,
            search: { file: moved.id },
            to: '/workspaces/$workspaceId',
          })
        }
        onShare={shareable?.sharePath ? () => setSharing(true) : undefined}
        readOnly={itemReadOnly}
        renameFieldLabel={m.files_file_name()}
        showMove={!standalone}
        topics={topics}
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
  // 2026-10-20); the offline icon stands in for it while offline. Its label
  // shows beside it in a 36rem-wide header for every file, Office included
  // (Epo 2026-10-22).
  const status = (
    <>
      <OfflineStatus />
      <EditorSaveStatus labelWhenWide store={editorStatus} />
      {!compact && <WorkspaceStatusButton />}
    </>
  );
  // One row for the status icons, its button box pulled in so the cloud's ink
  // sits about 10px after the name or the Hidden chip, as the right side's
  // buttons are apart (Epo 2026-11-16). Phones, where the status follows the
  // title's chevron, pull it further, about as far as the name from its icon.
  const statusRow = (
    <div className={cn('flex items-center', compact ? '-ml-2' : '-ml-1')}>
      {status}
    </div>
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
          WEBKIT ? 'group/header' : '@container/header',
          'grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 border-divider border-b',
          menuShown
            ? 'h-15 grid-rows-[24px_24px] gap-y-1 pt-1.5'
            : 'h-12 items-center sm:h-15',
          // Workspace buttons at the left edge (24px here, the right's are
          // full size) sit as far in as the right's.
          leading ? 'pr-3 pl-4' : 'pr-2 pl-4'
        )}
        data-layout="office"
        data-rows={menuShown ? 2 : 1}
        data-testid="content-header"
        ref={measureHeader}
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-2',
            // The workspace chrome at the row's height; the workspace picker
            // (a dropdown trigger) as a slimmer pill. The save status grows
            // with its label where it shows one, or its icon spills under ⋮.
            '[&_[data-slot=button]:not([data-variant])]:w-6 [&_[data-slot=button]]:h-6 [&_[role=status]]:size-6 @2xl/header:[&_[role=status]]:w-auto group-data-wide/header:[&_[role=status]]:w-auto',
            '[&_[data-slot=dropdown-menu-trigger]]:h-6 [&_[data-slot=dropdown-menu-trigger]]:gap-1.5 [&_[data-slot=dropdown-menu-trigger]]:px-2'
          )}
        >
          {leading}
          <div
            className={cn(
              'flex min-w-0 items-center gap-2',
              // After workspace buttons the file icon keeps the right side's
              // 19px ink gap.
              leading ? 'ml-0.5' : '-ml-2 sm:-ml-0.5 lg:ml-2'
            )}
          >
            {name}
            {statusRow}
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
          {menu}
        </div>
      </div>
    );
  return (
    <div
      className={cn(
        WEBKIT ? 'group/header' : '@container/header',
        // A tall page under it must not squeeze it (the Files view did).
        'flex h-12 shrink-0 items-center gap-1 border-divider border-b sm:h-15',
        // Workspace buttons at the left edge sit as far in as the right's.
        leading ? 'px-3' : 'pr-2 pl-2 sm:pl-4',
        // The title pill's padding already spaces it from the back button.
        !(leading && oneColumn) && 'sm:gap-2'
      )}
      data-center-header=""
      data-testid="content-header"
      ref={measureHeader}
    >
      {leading}
      <div
        className={cn(
          'flex min-w-0 items-center gap-1.5 sm:gap-2',
          // A file icon after workspace buttons, bare or in the title pill,
          // keeps their 19px ink gap; standalone headers pull in a little.
          !leading && '-ml-0.5',
          !leading && 'lg:ml-2'
        )}
      >
        {oneColumn ? (
          name
        ) : (
          <>
            {fileIcon}
            <h2 className={cn(nameClassName, 'flex-1')}>{title ?? '--'}</h2>
            {hiddenChip}
          </>
        )}
        {statusRow}
      </div>
      <div className="ml-auto flex items-center gap-0">
        {right}
        {menu}
      </div>
    </div>
  );
}
