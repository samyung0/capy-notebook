import {
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from '@tanstack/react-router';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type PanelSize, usePanelRef } from 'react-resizable-panels';
import { addChapterBodyNameMax } from '@/api/gen/validators';
import {
  useAddChapter,
  useChapters,
  useFiles,
  useUpdateChapter,
  useWorkspace,
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
import { officeFormatOf } from '@/features/files/fileUtils';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import { useOfficeEditGuard } from '@/features/files/useOfficeEditGuard';
import { CenterContent } from '@/features/materials/CenterContent';
import type { OneColumnChrome } from '@/features/materials/CenterContentHeader';
import {
  type OpenItem,
  openItemFromSearch,
  searchFromOpenItem,
  type WorkspaceOpenSearch,
} from '@/features/materials/openItem';
import { StudyPanel } from '@/features/study/StudyPanel';
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

type PanelTab = 'study' | 'files' | 'chat';
type LeftView = 'chats' | 'files' | 'study';

const isPanelTab = (value: unknown): value is PanelTab =>
  value === 'study' || value === 'files' || value === 'chat';
const isLeftView = (value: unknown): value is LeftView =>
  value === 'chats' || value === 'files' || value === 'study';

// The rail is 32% of the group from 1380px up (~438px at a 1400px window).
// Narrower, it takes three quarters of the lost width down to 400px, the
// least a rich chat answer (cards, tables, charts) reads well in.
/** The header's panel toggles while their panel is open: the icon's strip
 * fills in the accent. */
const PANEL_TOGGLE_OPEN = 'text-action-accent hover:text-action-accent';
const RAIL_SHARE = 0.32;
const RAIL_FULL_AT = 1380;
const RAIL_MIN = 400;
function railSize(groupWidth: number) {
  if (groupWidth >= RAIL_FULL_AT) return `${RAIL_SHARE * 100}%`;
  return `${Math.max(RAIL_MIN, RAIL_SHARE * RAIL_FULL_AT - 0.75 * (RAIL_FULL_AT - groupWidth))}px`;
}

/** A collapsible panel was dragged under its least width. Reopening a
 * collapsed panel also reports a zero size, which must not close it again. */
function collapsedByDrag(size: PanelSize, previous: PanelSize | undefined) {
  return size.inPixels === 0 && !!previous && previous.inPixels > 0;
}

/** The right rail. Closed, it collapses to nothing but stays mounted, so a
 * chat keeps its thread, draft and stream. Opening fits it to the group;
 * with the left panel closed it refits whenever the group's width changes,
 * which also drops a width the user dragged. Dragging it under its least
 * width closes it. */
function RailPanel({
  fitToWidth,
  open,
  onCollapse,
  children,
}: {
  fitToWidth: boolean;
  open: boolean;
  onCollapse: () => void;
  children: ReactNode;
}) {
  const panelRef = usePanelRef();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const group = element?.parentElement;
    if (!group) return;
    // The first callback lands after the group has registered its panels.
    let first = true;
    const observer = new ResizeObserver(([entry]) => {
      const panel = panelRef.current;
      if (!open) {
        if (panel && !panel.isCollapsed()) panel.collapse();
      } else if (first || fitToWidth) {
        panel?.resize(railSize(entry.contentRect.width));
      }
      first = false;
    });
    observer.observe(group);
    return () => observer.disconnect();
  }, [element, fitToWidth, open, panelRef]);
  return (
    <ResizablePanel
      className="overflow-visible!"
      collapsible
      defaultSize={open ? '32%' : '0%'}
      elementRef={setElement}
      id="rail"
      maxSize="50%"
      minSize={`${RAIL_MIN}px`}
      onResize={(size, _id, previous) => {
        if (open && collapsedByDrag(size, previous)) onCollapse();
      }}
      panelRef={panelRef}
    >
      {children}
    </ResizablePanel>
  );
}

export default function WorkspaceOpen() {
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
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const readOnly = isWorkspaceReadOnly(ws?.capabilities);
  const canClone = !!ws?.canClone;
  const { mutateAsync: addChapter } = useAddChapter(workspaceId);
  const { mutateAsync: updateChapter } = useUpdateChapter(workspaceId);
  const [cloneOpen, setCloneOpen] = useState(false);

  // Breakpoints: one column below 1260px, side panels from there, the left
  // one only from xl up. The left starts open from 2xl, where there is room,
  // the right starts closed (a chat row opens it); both toggles and both
  // panels' views are remembered.
  const lg = useMediaQuery('(min-width: 1260px)');
  const xl = useMediaQuery('(min-width: 1280px)');
  const roomy = useMediaQuery('(min-width: 1536px)');
  const [leftOpen, setLeftOpen] = useLocalPref(
    PREF_KEYS.leftPanel,
    roomy,
    isBoolean
  );
  const [rightOpen, setRightOpen] = useLocalPref(
    PREF_KEYS.rightPanel,
    false,
    isBoolean
  );
  const oneColumnLayout = !lg;
  const leftShown = xl && leftOpen;
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
  const [officeEditDirty, setOfficeEditDirty] = useState(false);
  const confirmViewerReplacement = useOfficeEditGuard(officeEditDirty);
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

  /** `push` keeps the page behind in history (the Study progress page). */
  function setOpenItem(item: OpenItem | null, push = false) {
    if (!confirmViewerReplacement()) return;
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

  /** The Study progress page takes the centre pane; Back returns here. */
  function openProgress() {
    if (!confirmViewerReplacement()) return;
    setCitationTarget(null);
    setFilesOpen(false);
    navigate({ search: { progress: true }, to: '.' });
  }

  function openCitation(citation: Citation) {
    if (!confirmViewerReplacement()) return;
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
      <Panel sectionClassName="items-center justify-center h-full">
        <QueryPausedState />
      </Panel>
    );

  if (!ws)
    return (
      <WorkspaceError backLabel={m.workspace_back_to()} backTo="/workspaces" />
    );

  // Every role that can read the workspace studies, browses and chats; AI
  // generate lives in the Add file dialog. The rail's title switches views,
  // Files included while the left panel is open too.
  const railViews: PanelView<PanelTab>[] = [
    { icon: 'filesNav', label: m.workspace_tab_files(), value: 'files' },
    { icon: 'message', label: m.workspace_tab_chat(), value: 'chat' },
    { icon: 'knowledge', label: m.workspace_tab_study(), value: 'study' },
  ];
  function openChat(id: string | null) {
    setTab('chat');
    setRightOpen(true);
    setChatRequest((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 }));
  }
  const leftTitle = (
    <PanelTitleMenu
      onChange={setLeftView}
      value={leftView}
      views={[
        { icon: 'message', label: m.chat_chats(), value: 'chats' },
        { icon: 'filesNav', label: m.workspace_tab_files(), value: 'files' },
        { icon: 'knowledge', label: m.workspace_tab_study(), value: 'study' },
      ]}
    />
  );
  const rowProps = {
    // Viewers open settings too, for the one row they can use: reset their
    // own study progress.
    // Viewers only have their own Track progress (Others) and Reset.
    onOpenSettings: () =>
      setSettingsTab(canManageWorkspaceSettings(ws) ? 'general' : 'others'),
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
      label: m.workspace_study_progress(),
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
        workspaceName: ws.name,
      }
    : undefined;

  const addProps = readOnly
    ? {}
    : {
        onAddChapter: () => setChapterForm({ mode: 'add' }),
        onAddSource: setAddSource,
      };
  // The plus lives with the tree: on the rail's Files view.
  const railRow = (actions: TabAction[]) => (
    <PanelTabRow
      actions={actions}
      title={<PanelTitleMenu onChange={setTab} value={tab} views={railViews} />}
      {...rowProps}
      {...(tab === 'files' ? addProps : {})}
    />
  );
  // The workspace switcher is the first row of the file tree and scrolls
  // with it.
  const picker = (
    <div className="mt-2.5 flex flex-col">
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
      beforeReplace={confirmViewerReplacement}
      generating={generating}
      header={picker}
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
      beforeReplace={confirmViewerReplacement}
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
      <div className="min-h-0 flex-1" hidden={tab !== 'study'}>
        <StudyPanel
          onOpenItem={setOpenItem}
          onOpenProgress={openProgress}
          renderTabRow={tab === 'study' ? railRow : noRow}
          workspaceId={workspaceId}
        />
      </div>
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
    <Panel className="w-full" sectionClassName="h-full gap-0">
      <h1 className="sr-only">{ws.name}</h1>
      <WorkspaceHealth workspace={ws} />
      <AppErrorBoundary resetKeys={[openItem?.kind, openItem?.id]}>
        <CenterContent
          beforeFileDelete={confirmViewerReplacement}
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
          onFileViewerDirtyChange={setOfficeEditDirty}
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
          onOpenTrackProgress={() => setSettingsTab('others')}
          progress={!!search.progress}
          readOnly={readOnly}
          requestedMode={search.mode ?? null}
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
      sectionClassName="h-full gap-0 overflow-hidden"
    >
      {rail}
    </Panel>
  );
  // The left panel: chats, the file tree or study, members at its foot.
  const leftPanel = (
    <Panel className="w-full" frosted sectionClassName="h-full gap-0">
      <div className="flex h-full min-h-0 flex-col" data-workspace-left-panel>
        <div className="flex min-h-0 flex-1 flex-col">
          {leftView === 'files' ? (
            filesPanel((actions) => (
              <PanelTabRow actions={actions} title={leftTitle} {...addProps} />
            ))
          ) : leftView === 'study' ? (
            <StudyPanel
              onOpenItem={setOpenItem}
              onOpenProgress={openProgress}
              renderTabRow={(actions) => (
                <PanelTabRow actions={actions} title={leftTitle} />
              )}
              workspaceId={workspaceId}
            />
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
  // overflow-visible WITH important is so that shadow doesnt get clipped
  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-2.5">
        <ResizablePanelGroup
          className={cn(
            'overflow-visible! flex min-h-0 flex-1 gap-1.5',
            // Collapsed, the rail leaves no gap behind.
            !rightOpen && '[&>#rail]:hidden!'
          )}
          orientation="horizontal"
        >
          {leftShown && (
            <>
              <ResizablePanel
                className="overflow-visible!"
                collapsible
                defaultSize="340px"
                id="files"
                maxSize="420px"
                minSize="300px"
                // Dragged under its least width, it closes like the toggle.
                onResize={(size, _id, previous) => {
                  if (collapsedByDrag(size, previous)) setLeftOpen(false);
                }}
              >
                {leftPanel}
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          )}
          <ResizablePanel
            className="overflow-visible!"
            id="viewer"
            minSize={oneColumnLayout ? undefined : '400px'}
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
              {rightOpen && <ResizableHandle withHandle />}
              <RailPanel
                fitToWidth={!leftShown}
                onCollapse={() => setRightOpen(false)}
                open={rightOpen}
              >
                {railColumn}
              </RailPanel>
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
