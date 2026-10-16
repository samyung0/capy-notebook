import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { addChapterBodyNameMax } from '@/api/gen/validators';
import {
  useAddChapter,
  useChapters,
  useFiles,
  useUpdateChapter,
  useWorkspace,
} from '@/api/hooks';
import type { Citation, Region, ResourceRef } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { LoadingLarge } from '@/components/app/LoadingLarge';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
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
import { Tabs } from '@/components/ui/Tabs';
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
import { isWorkspaceReadOnly } from '@/features/workspace/access';
import { ChatPanel } from '@/features/workspace/ChatPanel';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import { FilesPanel } from '@/features/workspace/FilesPanel';
import type { GenerateMode } from '@/features/workspace/GenerateForm';
import { PanelTabRow, type TabAction } from '@/features/workspace/PanelTabRow';
import { WorkspaceHealth } from '@/features/workspace/WorkspaceHealth';
import { WorkspacePicker } from '@/features/workspace/WorkspacePicker';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';
import { isBoolean, PREF_KEYS, useLocalPref } from '@/lib/localPrefs';
import { useMediaQuery } from '@/lib/useMediaQuery';

type PanelTab = 'study' | 'files' | 'chat';

// The rail is 32% of the group from 1380px up (~438px at a 1400px window).
// Narrower, it takes three quarters of the lost width down to 400px, the
// least a rich chat answer (cards, tables, charts) reads well in.
const RAIL_SHARE = 0.32;
const RAIL_FULL_AT = 1380;
const RAIL_MIN = 400;
function railSize(groupWidth: number) {
  if (groupWidth >= RAIL_FULL_AT) return `${RAIL_SHARE * 100}%`;
  return `${Math.max(RAIL_MIN, RAIL_SHARE * RAIL_FULL_AT - 0.75 * (RAIL_FULL_AT - groupWidth))}px`;
}

/** The right rail. In two columns it refits whenever the group's width
 * changes, which also drops a width the user dragged. */
function RailPanel({
  fitToWidth,
  children,
}: {
  fitToWidth: boolean;
  children: ReactNode;
}) {
  const panelRef = usePanelRef();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const group = element?.parentElement;
    if (!(fitToWidth && group)) return;
    // The first callback lands after the group has registered its panels.
    const observer = new ResizeObserver(([entry]) => {
      panelRef.current?.resize(railSize(entry.contentRect.width));
    });
    observer.observe(group);
    return () => observer.disconnect();
  }, [element, fitToWidth, panelRef]);
  return (
    <ResizablePanel
      className="overflow-visible!"
      defaultSize="32%"
      elementRef={setElement}
      id="rail"
      maxSize="50%"
      minSize={`${RAIL_MIN}px`}
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

  // Breakpoints: one column below 1260px, the pinned file tree only from xl up.
  const lg = useMediaQuery('(min-width: 1260px)');
  const xl = useMediaQuery('(min-width: 1280px)');
  const [pinned, setPinned] = useLocalPref(
    PREF_KEYS.filesPinned,
    false,
    isBoolean
  );
  const layout = lg ? (xl && pinned ? 'three' : 'two') : 'one';
  function togglePinned() {
    setPinned(!pinned);
  }

  const searchedOpenItem = openItemFromSearch(search);
  const [tab, setTab] = useState<PanelTab>('files');
  // One column: Files drops from the top, under the header it was opened from.
  const [filesOpen, setFilesOpen] = useState(false);
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

  function setOpenItem(item: OpenItem | null) {
    if (!confirmViewerReplacement()) return;
    setCitationTarget(null);
    setFilesOpen(false);
    navigate({
      replace: true,
      search: searchFromOpenItem(item),
      to: '.',
    });
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
    const regions = citation.regions ?? [];
    const regionPage = regions.find((region) => region.page > 0)?.page;
    setCitationTarget({
      citation: citation.snippet
        ? { page: citation.pageStart ?? regionPage, quote: citation.snippet }
        : undefined,
      fileId: citation.fileId,
      regions,
    });
    navigate({
      replace: true,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  if (!ws && wsFetchStatus === 'paused')
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
  // generate lives in the Add file dialog.
  const panelTabs: PanelTab[] = ['files', 'chat', 'study'];
  const railTabs =
    layout === 'three' ? panelTabs.filter((t) => t !== 'files') : panelTabs;
  // Files lives on the left when pinned: the rail falls back to Chat.
  const railTab: PanelTab = railTabs.includes(tab) ? tab : 'chat';
  const tabLabel = (t: PanelTab) =>
    t === 'files'
      ? m.workspace_tab_files()
      : t === 'chat'
        ? m.workspace_tab_chat()
        : m.workspace_tab_study();
  const rowProps = {
    // Viewers open settings too, for the one row they can use: reset their
    // own study progress.
    onOpenSettings: () => setSettingsOpen(true),
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
          icon: 'archive',
          label: m.action_add_chapter(),
          onClick: () => setChapterForm({ mode: 'add' }),
        },
      ];
  const settingsItems: MenuItem[] = [
    {
      icon: 'settings',
      label: m.workspace_settings(),
      onClick: rowProps.onOpenSettings,
    },
  ];
  // The Files dropdown hangs from the header, which lives in CenterContent.
  const filesAnchor = useRef<HTMLElement | null>(null);
  function openFiles() {
    filesAnchor.current =
      viewerBox.current?.querySelector<HTMLElement>(
        '[data-testid=content-header],[data-slot=center-header]'
      ) ?? null;
    setFilesOpen(true);
  }
  const oneColumn: OneColumnChrome | undefined =
    layout === 'one'
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
  const tabs = (
    <Tabs
      className="relative inset-shadow-none min-w-0 flex-1 shrink"
      onChange={(value) => setTab(value as PanelTab)}
      tabs={railTabs.map((t) => ({ label: tabLabel(t), value: t }))}
      value={railTab}
    />
  );
  // The plus lives with the tree: on the rail's Files tab unless Files is
  // pinned left.
  const railRow = (actions: TabAction[]) => (
    <PanelTabRow
      actions={actions}
      tabs={tabs}
      {...rowProps}
      {...(layout === 'three' || railTab !== 'files' ? {} : addProps)}
    />
  );
  // The workspace switcher is the first row of the file tree and scrolls
  // with it.
  const picker = (
    <div className="-mx-2.5 mt-3 mb-1 flex flex-col">
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
      {...addProps}
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
      workspaceId={workspaceId}
    />
  );
  // Every tab stays mounted so chat keeps its state while hidden; only the
  // visible one draws the tab row.
  const noRow = () => null;
  // The Files dropdown's tree: the workspace as a plain row the size of a file
  // row (no switcher; Back leaves the workspace), Workspace settings pinned
  // under it, and the add actions in the header's ⋮ instead of the plus.
  const filesDropdown = (
    <FilesPanel
      beforeReplace={confirmViewerReplacement}
      className="h-auto flex-1"
      footer={
        <div className="flex shrink-0 flex-col border-divider border-t px-2.5 py-1.5">
          {[
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
              className="flex items-center gap-1.5 rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg"
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
      <div className="min-h-0 flex-1" hidden={railTab !== 'study'}>
        <StudyPanel
          onOpenItem={setOpenItem}
          renderTabRow={railTab === 'study' ? railRow : noRow}
          workspaceId={workspaceId}
        />
      </div>
      {layout !== 'three' && (
        <div className="min-h-0 flex-1" hidden={railTab !== 'files'}>
          {filesPanel(railTab === 'files' ? railRow : noRow)}
        </div>
      )}
      <div className="min-h-0 flex-1" hidden={railTab !== 'chat'}>
        <AppErrorBoundary resetKeys={[workspaceId]}>
          <ChatPanel
            canReprocess={ws.isOwner}
            color="purple"
            onOpenCitation={openCitation}
            onOpenResource={openChatResource}
            openResource={openItem}
            renderTabRow={railTab === 'chat' ? railRow : noRow}
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
                  aria-pressed={pinned}
                  label={
                    pinned ? m.workspace_unpin_files() : m.workspace_pin_files()
                  }
                  onClick={togglePinned}
                >
                  <Icon name="panelLeft" />
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
          onOpenSettings={rowProps.onOpenSettings}
          readOnly={readOnly}
          requestedMode={search.mode ?? null}
          workspaceId={workspaceId}
        />
      </AppErrorBoundary>
    </Panel>
  );

  const railColumn = (
    <div className="flex h-full w-full flex-col gap-2.5">
      <TopInsetBar className="w-full" />
      <Panel className="flex-1" sectionClassName="h-full gap-0 overflow-hidden">
        {rail}
      </Panel>
    </div>
  );

  // The viewer keeps one parent chain at every width: moving an Office iframe
  // to another parent reloads its runtime and refetches the document.
  // overflow-visible WITH important is so that shadow doesnt get clipped
  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-2.5">
        <ResizablePanelGroup
          className="overflow-visible! flex min-h-0 flex-1 gap-1.5"
          orientation="horizontal"
        >
          {layout === 'three' && (
            <>
              <ResizablePanel
                className="overflow-visible!"
                defaultSize="300px"
                id="files"
                maxSize="420px"
                minSize="300px"
              >
                <Panel className="w-full" sectionClassName="h-full gap-0">
                  {filesPanel((actions) => (
                    <PanelTabRow
                      actions={actions}
                      title={m.workspace_tab_files()}
                      {...addProps}
                    />
                  ))}
                </Panel>
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          )}
          <ResizablePanel
            className="overflow-visible!"
            id="viewer"
            minSize={layout === 'one' ? undefined : '400px'}
          >
            <div
              className="relative h-full"
              ref={viewerBox}
              style={{ '--office-inset': '0px' } as React.CSSProperties}
            >
              <FloatingBarContext.Provider
                value={layout === 'one' && !officeOpen}
              >
                <OfficeInsetContext.Provider value={setOfficeInset}>
                  {viewer}
                </OfficeInsetContext.Provider>
              </FloatingBarContext.Provider>
              {layout === 'one' && (
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
          {layout !== 'one' && (
            <>
              <ResizableHandle withHandle />
              <RailPanel fitToWidth={layout === 'two'}>{railColumn}</RailPanel>
            </>
          )}
        </ResizablePanelGroup>
        {layout === 'one' && (
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
      <WorkspaceSettingsDialog
        onClose={() => setSettingsOpen(false)}
        open={settingsOpen}
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
