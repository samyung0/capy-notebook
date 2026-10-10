import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { addChapterBodyNameMax } from '@/api/gen/validators';
import {
  useAddChapter,
  useChapters,
  useCloneWorkspace,
  useFiles,
  useUpdateChapter,
  useWorkspace,
} from '@/api/hooks';
import type { Citation, Region } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { LoadingLarge } from '@/components/app/LoadingLarge';
import { Panel } from '@/components/app/layout';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/Drawer';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { Icon, type IconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import {
  PageFloatingBar,
  PageFloatingBarButton,
} from '@/components/ui/PageFloatingBar';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/Resizable';
import { Tabs } from '@/components/ui/Tabs';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { userToast } from '@/components/ui/userToast';
import { officeFormatOf } from '@/features/files/fileUtils';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import { useOfficeEditGuard } from '@/features/files/useOfficeEditGuard';
import { CenterContent } from '@/features/materials/CenterContent';
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
import { FilesPanel } from '@/features/workspace/FilesPanel';
import type { GenerateMode } from '@/features/workspace/GenerateForm';
import { PanelTabRow, type TabAction } from '@/features/workspace/PanelTabRow';
import { WorkspaceHealth } from '@/features/workspace/WorkspaceHealth';
import { WorkspacePicker } from '@/features/workspace/WorkspacePicker';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { trackItemCloned } from '@/lib/analytics';
import { toastCloneError } from '@/lib/authToasts';
import { useMediaQuery } from '@/lib/useMediaQuery';

type PanelTab = 'study' | 'files' | 'chat';
const TAB_ICON: Record<PanelTab, IconName> = {
  chat: 'message',
  files: 'files',
  study: 'bookOpenCheck',
};
/** Three columns is a per-browser preference, not per workspace. */
const PIN_KEY = 'capy.workspace.filesPinned';

export default function WorkspaceOpen() {
  const params = useParams({ strict: false });
  const workspaceId = (params as { workspaceId: string }).workspaceId;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as WorkspaceOpenSearch;

  // Other failures without data go to the error boundary.
  const { data: ws, isLoading: wsLoading } = useWorkspace(workspaceId, {
    errorBoundary: 'unlessMissing',
  });
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const readOnly = isWorkspaceReadOnly(ws?.capabilities);
  const canClone = !!ws?.canClone;
  const { mutateAsync: addChapter } = useAddChapter(workspaceId);
  const { mutateAsync: updateChapter } = useUpdateChapter(workspaceId);
  const { isPending: cloneWorkspaceIsPending, mutate: cloneWorkspace } =
    useCloneWorkspace({ errorToast: false });

  // Breakpoints: one column below lg, the pinned file tree only from xl up.
  const lg = useMediaQuery('(min-width: 1024px)');
  const xl = useMediaQuery('(min-width: 1280px)');
  const [pinned, setPinned] = useState(
    () => localStorage.getItem(PIN_KEY) === '1'
  );
  const layout = lg ? (xl && pinned ? 'three' : 'two') : 'one';
  function togglePinned() {
    const next = !pinned;
    localStorage.setItem(PIN_KEY, next ? '1' : '0');
    setPinned(next);
  }

  const searchedOpenItem = openItemFromSearch(search);
  // Files when nothing is open, Chat when the URL already points at an item.
  const [tab, setTab] = useState<PanelTab>(searchedOpenItem ? 'chat' : 'files');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [citationTarget, setCitationTarget] = useState<{
    fileId: string;
    regions: Region[];
    citation?: OfficeCitation;
  } | null>(null);
  const [officeEditDirty, setOfficeEditDirty] = useState(false);
  const confirmViewerReplacement = useOfficeEditGuard(officeEditDirty);
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
    setToolsOpen(false);
    navigate({
      replace: true,
      search: searchFromOpenItem(item),
      to: '.',
    });
  }

  function openCitation(citation: Citation) {
    if (!confirmViewerReplacement()) return;
    if (citation.materialId) {
      setToolsOpen(false);
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
    setToolsOpen(false);
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
  function showTab(next: PanelTab) {
    setTab(next);
    if (layout === 'one') setToolsOpen(true);
  }

  const rowProps = {
    // Viewers open settings too, for the one row they can use: reset their
    // own study progress.
    onOpenSettings: () => setSettingsOpen(true),
  };
  // Below lg an open Office file keeps its bottom chrome (sheet tabs, slide
  // pager) clear: the tools bar folds into one morphing button, as the Files
  // panel's plus.
  const openFile =
    openItem?.kind === 'file'
      ? files?.find((file) => file.id === openItem.id)
      : undefined;
  const officeOpen = !!openFile && !!officeFormatOf(openFile);
  const toolItems: MenuItem[] = [
    ...panelTabs.map((t) => ({
      icon: TAB_ICON[t],
      label: tabLabel(t),
      onClick: () => showTab(t),
    })),
    ...(rowProps.onOpenSettings
      ? [
          {
            icon: 'settings' as const,
            label: m.workspace_settings_short(),
            onClick: rowProps.onOpenSettings,
          },
        ]
      : []),
  ];
  const addProps = readOnly
    ? {}
    : {
        onAddChapter: () => setChapterForm({ mode: 'add' }),
        onAddSource: setAddSource,
      };
  const tabs = (
    <Tabs
      className="relative inset-shadow-none min-w-0 flex-1 shrink"
      onChange={(value) => showTab(value as PanelTab)}
      tabs={railTabs.map((t) => ({ label: tabLabel(t), value: t }))}
      value={railTab}
    />
  );
  // The plus lives with the tree: on the rail row unless Files is pinned left.
  const railRow = (actions: TabAction[]) => (
    <PanelTabRow
      actions={actions}
      tabs={tabs}
      {...rowProps}
      {...(layout === 'three' ? {} : addProps)}
    />
  );
  const filesPanel = (renderTabRow: (actions: TabAction[]) => ReactNode) => (
    <FilesPanel
      {...addProps}
      beforeReplace={confirmViewerReplacement}
      contentClassName={layout === 'three' ? undefined : 'pt-2'}
      generating={generating}
      onNavigate={() => {
        setCitationTarget(null);
        setToolsOpen(false);
      }}
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
            onOpenResource={(ref) =>
              setOpenItem(
                ref.kind === 'material'
                  ? { id: ref.id, kind: 'material' }
                  : { id: ref.id, kind: 'file' }
              )
            }
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
            <>
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
                      pinned
                        ? m.workspace_unpin_files()
                        : m.workspace_pin_files()
                    }
                    onClick={togglePinned}
                  >
                    <Icon name="panelLeft" />
                  </ToolbarButton>
                )}
              </div>
              {lg && (
                <WorkspacePicker
                  cloning={cloneWorkspaceIsPending}
                  onClone={
                    readOnly && canClone
                      ? () =>
                          cloneWorkspace(workspaceId, {
                            onError: (err) => toastCloneError(err, 'workspace'),
                            onSuccess: ({ workspace }) => {
                              trackItemCloned('workspace');
                              userToast({
                                title: m.workspace_cloned(),
                                variant: 'success',
                              });
                              navigate({
                                params: { workspaceId: workspace.id },
                                to: '/workspaces/$workspaceId',
                              });
                            },
                          })
                      : undefined
                  }
                  onOpenSettings={rowProps.onOpenSettings}
                  workspace={ws}
                />
              )}
            </>
          }
          onDeleted={() => setOpenItem(null)}
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
                defaultSize="270px"
                id="files"
                maxSize="420px"
                minSize="230px"
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
            <div className="relative h-full">
              <FloatingBarContext.Provider
                value={layout === 'one' && !officeOpen}
              >
                {viewer}
              </FloatingBarContext.Provider>
              {layout === 'one' && officeOpen && (
                <div
                  // Above an open PPTX notes box (PptxView's data-office-notes-open).
                  className="absolute right-4 bottom-14 z-10 flex [:has([data-office-notes-open])>&]:bottom-28"
                  data-workspace-tools-menu
                >
                  <Menu
                    items={toolItems}
                    trigger={
                      <IconButton
                        className="size-11 rounded-full p-2.5 text-solid-accent-1 active:scale-100"
                        icon="panelRight"
                        label={m.workspace_tools()}
                        strokeWidth={2.2}
                        variant="ghost-hover"
                      />
                    }
                    variant="morph"
                  />
                </div>
              )}
              {layout === 'one' && !officeOpen && (
                <PageFloatingBar
                  aria-label={m.workspace_tools()}
                  open={!toolsOpen}
                >
                  {panelTabs.map((t) => (
                    <PageFloatingBarButton
                      icon={TAB_ICON[t]}
                      key={t}
                      label={tabLabel(t)}
                      onClick={() => showTab(t)}
                    />
                  ))}
                  {rowProps.onOpenSettings && (
                    <PageFloatingBarButton
                      icon="settings"
                      label={m.workspace_settings()}
                      onClick={rowProps.onOpenSettings}
                      text={m.workspace_settings_short()}
                    />
                  )}
                </PageFloatingBar>
              )}
            </div>
          </ResizablePanel>
          {layout !== 'one' && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                className="overflow-visible!"
                // Relative so the rail grows on wide screens; ~410px at 1280px.
                defaultSize="32%"
                id="rail"
                maxSize="50%"
                minSize="300px"
              >
                {railColumn}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        {layout === 'one' && (
          <Drawer
            onOpenChange={setToolsOpen}
            open={toolsOpen}
            showSwipeHandle
            swipeDirection="down"
          >
            <DrawerContent
              keepMounted
              style={{ '--drawer-height': '82dvh' } as React.CSSProperties}
            >
              <DrawerTitle className="sr-only">
                {m.workspace_tools()}
              </DrawerTitle>
              {rail}
            </DrawerContent>
          </Drawer>
        )}
      </div>
      <WorkspaceSettingsDialog
        onClose={() => setSettingsOpen(false)}
        open={settingsOpen}
        workspace={ws}
      />
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
