import { useQuery } from '@tanstack/react-query';
import {
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from '@tanstack/react-router';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type GroupImperativeHandle,
  useGroupRef,
} from 'react-resizable-panels';
import { createStore, type StoreApi, useStore } from 'zustand';
import { isApiError } from '@/api/client';
import { addChapterBodyNameMax } from '@/api/gen/validators';
import {
  useAddChapter,
  useChapters,
  useFile,
  useFiles,
  useUpdateChapter,
  useVisitWorkspace,
  useWorkspace,
  workspaceQuery,
} from '@/api/hooks';
import type { Citation, Region, ResourceRef } from '@/api/types';
import { AccountFooter } from '@/components/app/AccountFooter';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { LoadingLarge } from '@/components/app/LoadingLarge';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import {
  FloatingBarContext,
  OfficeInsetContext,
} from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/Popover';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/Resizable';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { followMoves } from '@/features/files/fileMoved';
import { officeFormatOf } from '@/features/files/fileUtils';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import {
  registerTourPanels,
  type TourPanels,
} from '@/features/guide/tourStore';
import { CenterContent } from '@/features/materials/CenterContent';
import type { OneColumnChrome } from '@/features/materials/CenterContentHeader';
import {
  type OpenItem,
  openItemFromSearch,
  searchFromOpenItem,
  type WorkspaceOpenSearch,
} from '@/features/materials/openItem';
import {
  AddSourceDialog,
  type AddSourceMode,
  resumedConnect,
} from '@/features/workspace/AddSourceDialog';
import {
  canManageWorkspaceSettings,
  isWorkspaceReadOnly,
} from '@/features/workspace/access';
import { ChatPanel, type ChatRequest } from '@/features/workspace/ChatPanel';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import { ArchivedChatsDialog } from '@/features/workspace/chat/ArchivedChatsDialog';
import { ConversationList } from '@/features/workspace/chat/ConversationList';
import { FilesPanel } from '@/features/workspace/FilesPanel';
import type { GenerateMode } from '@/features/workspace/GenerateForm';
import { PanelTabRow, type TabAction } from '@/features/workspace/PanelTabRow';
import {
  PanelTitleMenu,
  type PanelView,
} from '@/features/workspace/PanelTitleMenu';
import type { SettingsTab } from '@/features/workspace/settingsTabs';
import { WorkspaceHealth } from '@/features/workspace/WorkspaceHealth';
import { WorkspacePicker } from '@/features/workspace/WorkspacePicker';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { isBoolean, PREF_KEYS, useLocalPref } from '@/lib/localPrefs';
import { waitsForConnection } from '@/lib/online';
import { useMediaQuery } from '@/lib/useMediaQuery';

type PanelTab = 'files' | 'chat';
type LeftView = 'chats' | 'files';

const isPanelTab = (value: unknown): value is PanelTab =>
  value === 'files' || value === 'chat';
const isLeftView = (value: unknown): value is LeftView =>
  value === 'chats' || value === 'files';

/** The header's panel toggles while their panel is open: the icon's strip
 * fills in the accent. */
const PANEL_TOGGLE_OPEN = 'text-action-accent hover:text-action-accent';
const LEFT_SIZE = 340;
const LEFT_MIN = 300;
const VIEWER_MIN = 400;
// The rail is 32% of the group from 1380px up (~438px at a 1400px window).
// Narrower, it takes three quarters of the lost width down to 400px, the
// least a rich chat answer (cards, tables, charts) reads well in.
const RAIL_SHARE = 0.32;
const RAIL_FULL_AT = 1380;
const RAIL_MIN = 400;
function railSize(groupWidth: number) {
  if (groupWidth >= RAIL_FULL_AT) return RAIL_SHARE * groupWidth;
  return Math.max(
    RAIL_MIN,
    RAIL_SHARE * RAIL_FULL_AT - 0.75 * (RAIL_FULL_AT - groupWidth)
  );
}

type Side = 'files' | 'rail';

/** The side panel whose handle is being dragged. A store, so a drag
 * re-renders the two side panels and not the workspace. */
type HeldHandle = StoreApi<{ side: Side | null }>;

/** A side panel. Closed, it collapses to nothing but stays mounted, so the
 * rail's chat keeps its thread, draft and stream. usePanelLayout places it;
 * dragging it under its least width closes it on release. While the other
 * side's handle is dragged it is disabled: the library otherwise takes space
 * past the viewer's least width from it, shrinking or collapsing the panel
 * across the viewer. Only during the drag: the library ignores a handle
 * beside a disabled panel, so the other handle could not be taken. */
function SidePanel({
  id,
  held,
  minSize,
  maxSize,
  className,
  children,
}: {
  id: Side;
  held: HeldHandle;
  minSize: string;
  maxSize: string;
  className: string;
  children: ReactNode;
}) {
  const otherHeld = useStore(
    held,
    (state) => !!state.side && state.side !== id
  );
  return (
    <ResizablePanel
      className={cn('overflow-visible!', className)}
      collapsible
      // Constant: a changing defaultSize re-registers the group.
      defaultSize="0%"
      disabled={otherHeld}
      id={id}
      maxSize={maxSize}
      minSize={minSize}
    >
      {children}
    </ResizablePanel>
  );
}

/** Marks which side panel's handle a press took, until the pointer lets go.
 * The library hit-tests handles by geometry, not by the event's target, and
 * focuses the handle it took in its document capture listener: read in the
 * window's bubble phase, after it, the active element says which. */
function useHeldHandle(held: HeldHandle) {
  useEffect(() => {
    const press = () => {
      const side = (document.activeElement as HTMLElement | null)?.dataset.side;
      if (side === 'files' || side === 'rail') held.setState({ side });
    };
    const release = () => held.setState({ side: null });
    window.addEventListener('pointerdown', press);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    return () => {
      window.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
  }, [held]);
}

/** Lays the side panels out whenever one opens or closes: the panel that did
 * not change keeps its width and the viewer takes the difference (the
 * library's own resize moves space to and from the farthest panel first, so
 * opening the rail collapsed the left panel). The left opens at 340px, the
 * rail at railSize, which it follows when the window resizes while it is the
 * only side panel open. When the viewer would drop under its least width, the
 * rail and then the left give way down to theirs. */
function usePanelLayout({
  group,
  groupRef,
  left,
  right,
}: {
  group: HTMLDivElement | null;
  groupRef: RefObject<GroupImperativeHandle | null>;
  left: boolean;
  right: boolean;
}) {
  useEffect(() => {
    if (!group) return;
    // The first callback lands after the group has registered its panels.
    let first = true;
    const observer = new ResizeObserver(([entry]) => {
      const handle = groupRef.current;
      const width = entry.contentRect.width;
      const fit = right && !left;
      if (!(handle && width > 0 && (first || fit))) return;
      const current = handle.getLayout();
      // The library reads a layout's sizes by position, in the order its
      // panels registered (not the DOM's): the current layout's keys give
      // that order. None yet: the group has no size, wait for one.
      const order = Object.keys(current);
      if (order.length === 0) return;
      // The first callback after a toggle keeps the rail's width; later
      // ones are window resizes, which refit it.
      const toggled = first;
      first = false;
      const kept = (id: string) => ((current[id] ?? 0) * width) / 100;
      let files = left ? kept('files') || LEFT_SIZE : 0;
      let rail = right ? (toggled ? kept('rail') : 0) || railSize(width) : 0;
      let short = VIEWER_MIN - (width - files - rail);
      if (short > 0 && rail > 0) {
        const give = Math.min(short, rail - RAIL_MIN);
        rail -= Math.max(give, 0);
        short -= Math.max(give, 0);
      }
      if (short > 0 && files > 0) files -= Math.min(short, files - LEFT_MIN);
      const share = (px: number) => (px / width) * 100;
      const sizes: Record<string, number> = {
        files: share(files),
        rail: share(rail),
        viewer: 100 - share(files) - share(rail),
      };
      handle.setLayout(Object.fromEntries(order.map((id) => [id, sizes[id]])));
    });
    observer.observe(group);
    return () => observer.disconnect();
  }, [group, groupRef, left, right]);
}

/** A read this user may not make (gone or forbidden). */
function missing(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 403);
}

/** The open file follows its workspace (Q455, Q462, Q467). A Move's room
 * message is acted on at once (`followMoves`): into the target workspace
 * when this user can read it, else the file closes here. Without it (an old
 * bookmark, a PDF, a tab that was closed), a fresh settled file read naming
 * another workspace opens the file there once that workspace reads, a
 * standalone file at `/files`; an unreadable file shows the usual panel. A
 * file read is fresh once this page saw it within its staleness window, and
 * stays so however long the workspace read takes (L4); a row restored from
 * storage, a read in flight or one seen fresh on another page never moves
 * the page. Opened PDFs never refetch their
 * file, so they follow on their next open. Every follow replaces history and
 * opens the file as a normal open does: its mode and the panels from this
 * device, out of full screen. */
function useFollowOpenFile(workspaceId: string, fileId: string | null) {
  const navigate = useNavigate();
  const {
    data: file,
    dataUpdatedAt,
    error,
    isFetching,
    isStale,
  } = useFile(fileId, { errorBoundary: false });
  const settled = !!fileId && !isFetching;
  // The read last seen fresh on this page (L4).
  const fresh = useRef({ at: 0, workspaceId: '' });
  if (settled && !isStale) fresh.current = { at: dataUpdatedAt, workspaceId };
  const elsewhere =
    settled &&
    fresh.current.at === dataUpdatedAt &&
    fresh.current.workspaceId === workspaceId &&
    !error &&
    file?.id === fileId &&
    file.workspaceId !== workspaceId
      ? file.workspaceId
      : undefined;
  const { data: target, error: targetError } = useQuery({
    ...workspaceQuery(elsewhere ?? ''),
    enabled: !!elsewhere,
    meta: { errorBoundary: false },
  });
  const follow = useCallback(
    (to: string | null) => {
      if (!fileId) return;
      if (to === null)
        navigate({
          replace: true,
          search: (previous) => ({
            ...previous,
            file: undefined,
            fullscreen: undefined,
            mode: undefined,
            page: undefined,
          }),
          to: '.',
        });
      else if (to === '')
        navigate({ params: { fileId }, replace: true, to: '/files/$fileId' });
      else
        navigate({
          params: { workspaceId: to },
          replace: true,
          search: { file: fileId },
          to: '/workspaces/$workspaceId',
        });
    },
    [fileId, navigate]
  );
  useEffect(
    () =>
      followMoves((moved, to) => {
        if (moved === fileId) follow(to);
      }),
    [fileId, follow]
  );
  useEffect(() => {
    if (elsewhere === '') follow('');
    else if (elsewhere && target) follow(elsewhere);
    else if (elsewhere && missing(targetError)) follow(null);
  }, [elsewhere, follow, target, targetError]);
}

/** The follow re-renders whenever the open file's row fetches, as it does on
 * any navigation once the row is 5 s stale (the route's loader prefetches
 * it), a citation click included. Beside the page it re-renders alone, not
 * the whole workspace in the middle of the citation's scroll. */
function FollowOpenFile() {
  const params = useParams({ strict: false });
  const workspaceId = (params as { workspaceId: string }).workspaceId;
  const search = useSearch({ strict: false }) as WorkspaceOpenSearch;
  useFollowOpenFile(workspaceId, search.file ?? null);
  return null;
}

export default function WorkspaceOpenPage() {
  return (
    <>
      <FollowOpenFile />
      <WorkspaceOpen />
    </>
  );
}

function WorkspaceOpen() {
  const params = useParams({ strict: false });
  const workspaceId = (params as { workspaceId: string }).workspaceId;
  const navigate = useNavigate();
  const router = useRouter();
  const search = useSearch({ strict: false }) as WorkspaceOpenSearch;

  // Other failures without data go to the error boundary.
  const {
    data: ws,
    fetchStatus: wsFetchStatus,
    isLoading: wsLoading,
  } = useWorkspace(workspaceId, {
    errorBoundary: 'unlessMissing',
  });
  // Each open is a visit: recent workspaces sort by it, and a link or public
  // workspace a visitor opened lists with their own.
  const visit = useVisitWorkspace();
  const loaded = !!ws;
  const visitor = !ws?.role;
  useEffect(() => {
    if (loaded) visit({ id: workspaceId, visitor });
  }, [loaded, visit, visitor, workspaceId]);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const readOnly = isWorkspaceReadOnly(ws?.capabilities);
  const canClone = !!ws?.canClone;
  const { mutateAsync: addChapter } = useAddChapter(workspaceId);
  const { mutateAsync: updateChapter } = useUpdateChapter(workspaceId);
  const [cloneOpen, setCloneOpen] = useState(false);

  // Breakpoints: one column below 1260px, side panels from there, the left
  // one only from xl up. The left starts open, the right closed (a chat row
  // opens it); both toggles and both panels' views are remembered.
  const lg = useMediaQuery('(min-width: 1260px)');
  const xl = useMediaQuery('(min-width: 1280px)');
  const [leftOpen, setLeftOpen] = useLocalPref(
    PREF_KEYS.leftPanel,
    true,
    isBoolean
  );
  const [rightOpen, setRightOpen] = useLocalPref(
    PREF_KEYS.rightPanel,
    false,
    isBoolean
  );
  const oneColumnLayout = !lg;
  const leftShown = xl && leftOpen;
  const panelGroupRef = useGroupRef();
  const [heldHandle] = useState<HeldHandle>(() =>
    createStore(() => ({ side: null }))
  );
  useHeldHandle(heldHandle);
  const [panelGroup, setPanelGroup] = useState<HTMLDivElement | null>(null);
  usePanelLayout({
    // One column has no side panels to place.
    group: lg ? panelGroup : null,
    groupRef: panelGroupRef,
    left: leftShown,
    right: rightOpen,
  });
  const [leftView, setLeftView] = useLocalPref(
    PREF_KEYS.leftView,
    'chats',
    isLeftView
  );
  const [archivedOpen, setArchivedOpen] = useState(false);
  // The left panel's chat list drives the rail's chat, which reports back
  // the thread it shows.
  const [chatRequest, setChatRequest] = useState<ChatRequest>();
  const [activeChat, setActiveChat] = useState<string | null>(null);

  const searchedOpenItem = openItemFromSearch(search);
  const [tab, setTab] = useLocalPref(PREF_KEYS.rightView, 'files', isPanelTab);
  // One column: Files drops from the top, under the header it was opened from.
  const [filesOpen, setFilesOpen] = useState(false);
  // The Files dropdown hangs from the header, which lives in CenterContent.
  const filesAnchor = useRef<HTMLElement | null>(null);
  const [citationTarget, setCitationTarget] = useState<{
    fileId: string;
    regions: Region[];
    citation?: OfficeCitation;
  } | null>(null);
  // The chat dock sits 8px above the Office frame's bottom chrome, which the
  // runtime reports; written to the box's style so the workspace does not
  // re-render while a resize moves it.
  const viewerBox = useRef<HTMLDivElement>(null);
  const setOfficeInset = useCallback((inset: number) => {
    viewerBox.current?.style.setProperty('--office-inset', `${inset}px`);
  }, []);
  const openItem =
    searchedOpenItem?.kind === 'file' &&
    citationTarget?.fileId === searchedOpenItem.id
      ? {
          ...searchedOpenItem,
          citation: citationTarget.citation,
          regions: citationTarget.regions,
        }
      : searchedOpenItem;

  /** `push` keeps the page behind in history (the Study page). */
  function setOpenItem(item: OpenItem | null, push = false) {
    setCitationTarget(null);
    setFilesOpen(false);
    navigate({
      replace: !push,
      search: searchFromOpenItem(item),
      to: '.',
    });
  }

  /** Workspace settings at `tab`, kept in the URL so a link can open it.
   * Opening, switching tabs and closing replace the entry, so the dialog
   * adds no history. */
  function setSettingsTab(tab: SettingsTab | undefined) {
    // The live URL, not this render's: a dialog closing because the app is
    // leaving (Back, Clone, Delete) finds no settings there and stays put.
    const latest = router.latestLocation.search as WorkspaceOpenSearch;
    if (tab === latest.settings) return;
    navigate({
      replace: true,
      search: (previous) => ({ ...previous, settings: tab }),
      to: '.',
    });
  }

  /** The Study page takes the centre pane; Back returns here. */
  function openProgress() {
    setCitationTarget(null);
    setFilesOpen(false);
    navigate({ search: { study: true }, to: '.' });
  }

  function openCitation(citation: Citation) {
    if (citation.materialId) {
      navigate({
        replace: true,
        search: { material: citation.materialId, mode: 'view' },
        to: '.',
      });
      return;
    }
    // A copy per click: PdfView scrolls and flashes once per regions array.
    const regions = [...(citation.regions ?? [])];
    const regionPage = regions.find((region) => region.page > 0)?.page;
    setCitationTarget({
      citation: citation.snippet
        ? { page: citation.pageStart ?? regionPage, quote: citation.snippet }
        : undefined,
      fileId: citation.fileId,
      regions,
    });
    // The router's scroll reset would abort the viewer's smooth scroll to
    // the cited box.
    navigate({
      replace: true,
      resetScroll: false,
      search: {
        ...searchFromOpenItem({
          id: citation.fileId,
          kind: 'file',
          page: regionPage ?? citation.pageStart ?? undefined,
        }),
        mode: 'view',
      },
      to: '.',
    });
  }

  const [generating, setGenerating] = useState<GenerateMode | null>(null);
  const [chapterForm, setChapterForm] = useState<
    { mode: 'add' } | { mode: 'rename'; id: string; name: string } | null
  >(null);
  const [resumeProvider] = useState(() => resumedConnect(workspaceId));
  const [addSource, setAddSource] = useState<AddSourceMode | null>(
    resumeProvider ? 'import' : null
  );
  // Get started links act once the workspace has loaded, then leave the URL.
  const { add, chat } = search;
  // Once per link: the panel setters change every render and the URL only
  // drops the params after the navigation lands.
  const linkTaken = useRef(false);
  useEffect(() => {
    if (!(add || chat)) {
      linkTaken.current = false;
      return;
    }
    if (!loaded || linkTaken.current) return;
    linkTaken.current = true;
    if (add && !readOnly) setAddSource('upload');
    if (chat) {
      setTab('chat');
      setRightOpen(true);
      setChatRequest((previous) => ({
        id: null,
        seq: (previous?.seq ?? 0) + 1,
      }));
    }
    navigate({
      replace: true,
      search: (previous) => ({ ...previous, add: undefined, chat: undefined }),
      to: '.',
    });
  }, [add, chat, loaded, navigate, readOnly, setRightOpen, setTab]);
  // The tour (features/guide/Tour.tsx) opens panels through these while this
  // page is open.
  const tourPanels = useRef<TourPanels | null>(null);
  useEffect(() => {
    tourPanels.current = {
      showChats: () => {
        setLeftOpen(true);
        setLeftView('chats');
      },
      showFiles: () => {
        setTab('files');
        setRightOpen(true);
      },
    };
  });
  useEffect(() => registerTourPanels(tourPanels), []);

  if (wsLoading) {
    return (
      <LoadingLarge
        backLabel={m.workspace_back_to()}
        backTo="/workspaces"
        title={m.workspace_loading()}
      />
    );
  }

  // Offline before the first load: the fetch resumes on reconnect.
  if (waitsForConnection(wsFetchStatus, ws))
    return (
      <Panel
        frost="center"
        sectionClassName="items-center justify-center h-full"
      >
        <QueryPausedState />
      </Panel>
    );

  if (!ws)
    return (
      <WorkspaceError backLabel={m.workspace_back_to()} backTo="/workspaces" />
    );

  // Every role that can read the workspace studies (the centre Study page),
  // browses and chats; AI generate lives in the Add file dialog. The rail's
  // title switches views, Files included while the left panel is open too.
  const railViews: PanelView<PanelTab>[] = [
    { icon: 'filesNav', label: m.workspace_tab_files(), value: 'files' },
    { icon: 'message', label: m.workspace_tab_chat(), value: 'chat' },
  ];
  function openChat(id: string | null) {
    setTab('chat');
    setRightOpen(true);
    setChatRequest((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 }));
  }
  // Both panels' title menus open the Study page in the centre.
  const studyItem: MenuItem = {
    icon: 'knowledge',
    label: m.workspace_tab_study(),
    onClick: openProgress,
  };
  const leftTitle = (
    <PanelTitleMenu
      extra={[studyItem]}
      onChange={setLeftView}
      value={leftView}
      views={[
        { icon: 'message', label: m.chat_chats(), value: 'chats' },
        { icon: 'filesNav', label: m.workspace_tab_files(), value: 'files' },
      ]}
    />
  );
  // Everyone has settings: owner and editor members open on General, viewers
  // and share-role visitors on their own Study tab.
  const rowProps = {
    onOpenSettings: () =>
      setSettingsTab(canManageWorkspaceSettings(ws) ? 'general' : 'study'),
  };
  // Below lg an open Office file keeps its bottom chrome (sheet tabs, slide
  // pager) clear: the chat dock stays a button above it.
  const openFile =
    openItem?.kind === 'file'
      ? files?.find((file) => file.id === openItem.id)
      : undefined;
  const officeOpen = !!openFile && !!officeFormatOf(openFile);

  // One column has no panels: the header title opens Files, and ⋮ carries
  // the workspace actions their tab rows held.
  const addItems: MenuItem[] = readOnly
    ? []
    : [
        {
          icon: 'plusCircle',
          label: m.action_add_file(),
          onClick: () => setAddSource('upload'),
        },
        {
          icon: 'chapter',
          label: m.action_add_chapter(),
          onClick: () => setChapterForm({ mode: 'add' }),
        },
      ];
  const settingsItems: MenuItem[] = [
    {
      icon: 'knowledge',
      label: m.workspace_tab_study(),
      onClick: openProgress,
    },
    {
      icon: 'settings',
      label: m.workspace_settings(),
      onClick: rowProps.onOpenSettings,
    },
  ];
  function openFiles() {
    filesAnchor.current =
      viewerBox.current?.querySelector<HTMLElement>(
        '[data-testid=content-header],[data-slot=center-header]'
      ) ?? null;
    setFilesOpen(true);
  }
  // The left panel foot's menu: Invite (sharing is managed by owners and
  // editors), then the study and settings rows.
  const footerItems: MenuItem[] = [
    ...(canManageWorkspaceSettings(ws)
      ? [
          {
            accent: true,
            icon: 'userAdd' as const,
            label: m.workspace_invite_member(),
            onClick: () => setSettingsTab('sharing'),
          },
        ]
      : []),
    ...settingsItems,
  ];
  const oneColumn: OneColumnChrome | undefined = oneColumnLayout
    ? {
        addItems,
        filesOpen,
        onOpenFiles: openFiles,
        settingsItems,
        workspaceIconId: ws.iconId,
        workspaceName: ws.name,
      }
    : undefined;

  const railRow = (actions: TabAction[]) => (
    <PanelTabRow
      actions={actions}
      title={
        <PanelTitleMenu
          extra={[studyItem]}
          onChange={setTab}
          value={tab}
          views={railViews}
        />
      }
      {...rowProps}
    />
  );
  // The workspace switcher leads the file tree and scrolls with it.
  const picker = (
    <div className="mt-1 flex flex-col">
      <WorkspacePicker
        onClone={readOnly && canClone ? () => setCloneOpen(true) : undefined}
        onOpenSettings={rowProps.onOpenSettings}
        workspace={ws}
      />
    </div>
  );

  const openChatResource = (ref: ResourceRef) =>
    setOpenItem(
      ref.kind === 'material'
        ? { id: ref.id, kind: 'material' }
        : { id: ref.id, kind: 'file' }
    );
  const filesPanel = (renderTabRow: (actions: TabAction[]) => ReactNode) => (
    <FilesPanel
      generating={generating}
      header={picker}
      onAddChapter={
        readOnly ? undefined : () => setChapterForm({ mode: 'add' })
      }
      onAddSource={readOnly ? undefined : setAddSource}
      onNavigate={() => setCitationTarget(null)}
      onOpenItem={setOpenItem}
      onRenameChapter={(ch) =>
        setChapterForm({ id: ch.id, mode: 'rename', name: ch.name })
      }
      openItem={openItem}
      readOnly={readOnly}
      renderTabRow={renderTabRow}
      searchable
      workspaceId={workspaceId}
    />
  );
  // Every tab stays mounted so chat keeps its state while hidden; only the
  // visible one draws the tab row.
  const noRow = () => null;
  // The Files dropdown's tree: the workspace as a plain row the size of a file
  // row (no switcher; Back leaves the workspace), Add file, Workspace settings
  // and Study pinned under it; Add chapter stays in the header's ⋮.
  const filesDropdown = (
    <FilesPanel
      className="h-auto flex-1"
      footer={
        <div className="flex shrink-0 flex-col gap-1 border-divider border-t px-2.5 pt-1.5 pb-2">
          {[
            ...addItems.slice(0, 1),
            ...settingsItems,
            ...(readOnly && canClone
              ? [
                  {
                    icon: 'clone' as const,
                    label: m.action_clone_workspace(),
                    onClick: () => setCloneOpen(true),
                  },
                ]
              : []),
          ].map((action) => (
            <button
              className="flex h-7.5 items-center gap-1.75 rounded-button px-2 text-left hover:bg-surface-hover-bg"
              key={action.label}
              onClick={() => {
                setFilesOpen(false);
                action.onClick?.();
              }}
              type="button"
            >
              {action.icon && <Icon name={action.icon} size={15} />}
              <span className="translate-y-px">{action.label}</span>
            </button>
          ))}
        </div>
      }
      generating={generating}
      header={
        <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1.5">
          <img
            alt=""
            className="size-3.75 shrink-0 rounded-[4px]"
            src={iconUrl(ws.iconId)}
          />
          <span className="min-w-0 translate-y-px truncate font-semibold">
            {ws.name}
          </span>
        </div>
      }
      onNavigate={() => {
        setCitationTarget(null);
        setFilesOpen(false);
      }}
      onOpenItem={setOpenItem}
      onRenameChapter={(ch) =>
        setChapterForm({ id: ch.id, mode: 'rename', name: ch.name })
      }
      openItem={openItem}
      readOnly={readOnly}
      renderTabRow={noRow}
      rowMenus={false}
      workspaceId={workspaceId}
    />
  );
  const rail = (
    <>
      <div className="min-h-0 flex-1" hidden={tab !== 'files'}>
        {filesPanel(tab === 'files' ? railRow : noRow)}
      </div>
      <div className="min-h-0 flex-1" hidden={tab !== 'chat'}>
        <AppErrorBoundary resetKeys={[workspaceId]}>
          <ChatPanel
            canReprocess={ws.isOwner}
            color="purple"
            historyButton={!leftShown}
            onActiveChange={setActiveChat}
            onOpenCitation={openCitation}
            onOpenResource={openChatResource}
            openResource={openItem}
            renderTabRow={tab === 'chat' ? railRow : noRow}
            request={chatRequest}
            workspaceId={workspaceId}
          />
        </AppErrorBoundary>
      </div>
    </>
  );

  const viewer = (
    <Panel className="w-full" frost="center" sectionClassName="h-full gap-0">
      <h1 className="sr-only">{ws.name}</h1>
      <WorkspaceHealth workspace={ws} />
      <AppErrorBoundary resetKeys={[openItem?.kind, openItem?.id]}>
        <CenterContent
          chapters={chapters ?? []}
          color="purple"
          item={openItem}
          leading={
            <div className="flex items-center gap-0">
              <ToolbarButton
                label={m.workspace_back_to()}
                onClick={() => navigate({ to: '/workspaces' })}
              >
                <Icon name="navigationBack" />
              </ToolbarButton>
              {xl && (
                <ToolbarButton
                  aria-pressed={leftOpen}
                  className={cn(leftOpen && PANEL_TOGGLE_OPEN)}
                  label={
                    leftOpen
                      ? m.workspace_close_side_panel()
                      : m.workspace_open_side_panel()
                  }
                  onClick={() => setLeftOpen(!leftOpen)}
                >
                  <Icon name={leftOpen ? 'panelLeftOpen' : 'panelLeft'} />
                </ToolbarButton>
              )}
            </div>
          }
          onAddFile={readOnly ? undefined : () => setAddSource('upload')}
          onDeleted={() => setOpenItem(null)}
          oneColumn={oneColumn}
          onModeChange={(mode) => {
            void navigate({
              // The viewer has already completed its save/export checks.
              ignoreBlocker: true,
              replace: true,
              search: (previous) => ({ ...previous, mode }),
              to: '.',
            });
          }}
          onOpenItem={(item) => setOpenItem(item, true)}
          onOpenProgress={openProgress}
          onOpenSettings={rowProps.onOpenSettings}
          plan={search.plan}
          readOnly={readOnly}
          requestedMode={search.mode ?? null}
          study={!!search.study}
          trailing={
            lg && (
              <ToolbarButton
                aria-pressed={rightOpen}
                className={cn(rightOpen && PANEL_TOGGLE_OPEN)}
                label={
                  rightOpen
                    ? m.workspace_close_right_panel()
                    : m.workspace_open_right_panel()
                }
                onClick={() => setRightOpen(!rightOpen)}
              >
                <Icon name={rightOpen ? 'panelRightOpen' : 'panelRight'} />
              </ToolbarButton>
            )
          }
          workspaceId={workspaceId}
        />
      </AppErrorBoundary>
    </Panel>
  );

  // The rail runs full height: the left panel's foot carries the account.
  const railColumn = (
    <Panel
      className="h-full w-full"
      frost="right"
      sectionClassName="h-full gap-0 overflow-hidden"
    >
      {rail}
    </Panel>
  );
  // The left panel: chats or the file tree, members at its foot.
  const leftPanel = (
    <Panel className="w-full" frost="left" sectionClassName="h-full gap-0">
      <div className="flex h-full min-h-0 flex-col" data-workspace-left-panel>
        <div className="flex min-h-0 flex-1 flex-col">
          {leftView === 'files' ? (
            filesPanel((actions) => (
              <PanelTabRow actions={actions} title={leftTitle} />
            ))
          ) : (
            <>
              <PanelTabRow
                actions={[
                  {
                    icon: 'archive',
                    label: m.chat_archived_title(),
                    onClick: () => setArchivedOpen(true),
                  },
                ]}
                title={leftTitle}
              />
              <ConversationList
                activeId={activeChat}
                onNew={() => openChat(null)}
                onOpen={openChat}
                onRemoved={(id) => id === activeChat && openChat(null)}
                workspaceId={workspaceId}
              />
            </>
          )}
        </div>
        <AccountFooter
          canInvite={canManageWorkspaceSettings(ws)}
          items={footerItems}
          member={!!ws.role}
          onOpenSettings={rowProps.onOpenSettings}
          workspaceId={workspaceId}
          workspaceName={ws.name}
        />
      </div>
    </Panel>
  );

  // The viewer keeps one parent chain at every width: moving an Office iframe
  // to another parent reloads its runtime and refetches the document.
  // The gaps between panels are padding inside them and the separators stay
  // mounted (disabled while their panel is closed): panels size as shares of
  // their summed width, so a gap or separator that came and went with a
  // panel shifted the other one, and a new separator re-registered the group,
  // which could restore a layout with the reopened panel at zero.
  // overflow-visible WITH important is so that shadow doesnt get clipped
  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-2.5">
        <ResizablePanelGroup
          className={cn(
            'group/panels overflow-visible! flex min-h-0 flex-1',
            // Collapsed, a side panel leaves no gap or handle behind.
            'data-files-collapsed:[&>#files]:hidden! data-rail-collapsed:[&>#rail]:hidden!',
            !leftOpen && '[&>#files]:hidden!',
            !rightOpen && '[&>#rail]:hidden!'
          )}
          elementRef={setPanelGroup}
          groupRef={panelGroupRef}
          // A drag can collapse a panel before the pointer lets go. Marked on
          // the group without a render, its gap and handle go in the same
          // frame; it closes only on release, so dragging back reopens it.
          onLayoutChange={(layout) => {
            panelGroup?.toggleAttribute('data-files-collapsed', !layout.files);
            panelGroup?.toggleAttribute('data-rail-collapsed', !layout.rail);
          }}
          onLayoutChanged={(layout, { isUserInteraction }) => {
            if (!isUserInteraction) return;
            if (leftOpen && layout.files === 0) setLeftOpen(false);
            if (rightOpen && layout.rail === 0) setRightOpen(false);
          }}
          orientation="horizontal"
        >
          {xl && (
            <>
              <SidePanel
                className="pr-1.5"
                held={heldHandle}
                id="files"
                maxSize="420px"
                minSize={`${LEFT_MIN}px`}
              >
                {/* Unlike the rail's chat, nothing here needs to survive closing. */}
                {leftOpen && leftPanel}
              </SidePanel>
              <ResizableHandle
                className="group-data-files-collapsed/panels:[&>div]:hidden"
                data-side="files"
                disabled={!leftOpen}
                withHandle={leftOpen}
              />
            </>
          )}
          <ResizablePanel
            className={cn(
              'overflow-visible!',
              leftShown && 'pl-1.5 group-data-files-collapsed/panels:pl-0',
              lg && rightOpen && 'pr-1.5 group-data-rail-collapsed/panels:pr-0'
            )}
            id="viewer"
            minSize={oneColumnLayout ? undefined : `${VIEWER_MIN}px`}
          >
            <div
              className="relative h-full"
              ref={viewerBox}
              style={{ '--office-inset': '0px' } as React.CSSProperties}
            >
              <FloatingBarContext.Provider
                value={oneColumnLayout && !officeOpen}
              >
                <OfficeInsetContext.Provider value={setOfficeInset}>
                  {viewer}
                </OfficeInsetContext.Provider>
              </FloatingBarContext.Provider>
              {oneColumnLayout && (
                <AppErrorBoundary resetKeys={[workspaceId]}>
                  <ChatPanel
                    canReprocess={ws.isOwner}
                    color="purple"
                    dock={{
                      // The page's ⋮ keeps Add file, not Add chapter.
                      menuItems: [...addItems.slice(0, 1), ...settingsItems],
                      office: officeOpen,
                    }}
                    onOpenCitation={openCitation}
                    onOpenResource={openChatResource}
                    openResource={openItem}
                    workspaceId={workspaceId}
                  />
                </AppErrorBoundary>
              )}
            </div>
          </ResizablePanel>
          {lg && (
            <>
              <ResizableHandle
                className="group-data-rail-collapsed/panels:[&>div]:hidden"
                data-side="rail"
                disabled={!rightOpen}
                withHandle={rightOpen}
              />
              <SidePanel
                className="pl-1.5"
                held={heldHandle}
                id="rail"
                maxSize="50%"
                minSize={`${RAIL_MIN}px`}
              >
                {railColumn}
              </SidePanel>
            </>
          )}
        </ResizablePanelGroup>
        {oneColumnLayout && (
          <Popover modal onOpenChange={setFilesOpen} open={filesOpen}>
            <PopoverAnchor
              virtualRef={{
                current: {
                  getBoundingClientRect: () =>
                    filesAnchor.current?.getBoundingClientRect() ??
                    new DOMRect(),
                },
              }}
            />
            {/* A plain dropdown under the header, its workspace row in line
                with the header title; full width on phones, a 400px column from sm. */}
            <PopoverContent
              align="start"
              alignOffset={16}
              aria-label={m.workspace_tab_files()}
              className="max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:w-100"
              collisionPadding={8}
              sideOffset={4}
            >
              {filesDropdown}
            </PopoverContent>
          </Popover>
        )}
      </div>
      <ArchivedChatsDialog
        onClose={() => setArchivedOpen(false)}
        open={archivedOpen}
        workspaceId={workspaceId}
      />
      <WorkspaceSettingsDialog
        onClose={() => setSettingsTab(undefined)}
        onTabChange={setSettingsTab}
        open={!!search.settings}
        tab={search.settings}
        workspace={ws}
      />
      {canClone && (
        <CloneWorkspaceDialog
          open={cloneOpen}
          setOpen={setCloneOpen}
          workspace={ws}
        />
      )}
      {chapterForm && (
        <NameFormDialog
          defaultName={chapterForm.mode === 'rename' ? chapterForm.name : ''}
          key={
            chapterForm.mode === 'rename'
              ? `rename-${chapterForm.id}`
              : 'add-chapter'
          }
          maxLength={addChapterBodyNameMax}
          onClose={() => setChapterForm(null)}
          onSubmit={async (name) => {
            if (chapterForm.mode === 'rename') {
              await updateChapter({ id: chapterForm.id, name });
            } else {
              await addChapter(name);
            }
          }}
          open
          submitLabel={
            chapterForm.mode === 'add' ? m.action_create() : m.action_save()
          }
          title={
            chapterForm.mode === 'add' ? m.chapter_new() : m.chapter_rename()
          }
        />
      )}
      {addSource && (
        <AddSourceDialog
          initialMode={addSource}
          onClose={() => setAddSource(null)}
          onGeneratingChange={setGenerating}
          onOpenItem={setOpenItem}
          open
          resumeProvider={resumeProvider}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}
