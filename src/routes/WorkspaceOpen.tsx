import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { isApiError } from '@/api/client';
import { addChapterBodyNameMax } from '@/api/gen/validators';
import {
  useAddChapter,
  useChapters,
  useCloneWorkspace,
  useFiles,
  useMaterials,
  useUpdateChapter,
  useWorkspace,
} from '@/api/hooks';
import type { Citation, Region } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { LoadingLarge } from '@/components/app/LoadingLarge';
import { Panel } from '@/components/app/layout';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/Drawer';
import type { IconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/Resizable';
import { Tabs } from '@/components/ui/Tabs';
import { userToast } from '@/components/ui/userToast';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import { useOfficeEditGuard } from '@/features/files/useOfficeEditGuard';
import { CenterContent } from '@/features/materials/CenterContent';
import {
  type OpenItem,
  openItemFromSearch,
  searchFromOpenItem,
  type WorkspaceOpenSearch,
} from '@/features/materials/openItem';
import {
  AddSourceDialog,
  type AddSourceMode,
} from '@/features/workspace/AddSourceDialog';
import {
  canManageWorkspaceSettings,
  isWorkspaceReadOnly,
} from '@/features/workspace/access';
import { ChatPanel } from '@/features/workspace/ChatPanel';
import { FilesPanel } from '@/features/workspace/FilesPanel';
import type { GenerateMode } from '@/features/workspace/GenerateFormDialog';
import { GeneratePanel } from '@/features/workspace/GeneratePanel';
import { PanelTabRow, type TabAction } from '@/features/workspace/PanelTabRow';
import { StorageOwnerBanner } from '@/features/workspace/StorageOwnerBanner';
import { WorkspaceMenu } from '@/features/workspace/WorkspaceMenu';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { toastCloneError } from '@/lib/authToasts';
import { trackItemCloned } from '@/lib/observability';
import { useMediaQuery } from '@/lib/useMediaQuery';

type PanelTab = 'files' | 'chat' | 'generate';
const TAB_ICON: Record<PanelTab, IconName> = {
  chat: 'message',
  files: 'files',
  generate: 'sparkles',
};
/** Three columns is a per-browser preference, not per workspace. */
const PIN_KEY = 'capy.workspace.filesPinned';

export default function WorkspaceOpen() {
  const params = useParams({ strict: false });
  const workspaceId = (params as { workspaceId: string }).workspaceId;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as WorkspaceOpenSearch;

  const {
    data: ws,
    isLoading: wsLoading,
    error: wsErr,
  } = useWorkspace(workspaceId, { errorBoundary: false });
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const readOnly = isWorkspaceReadOnly(ws?.capabilities);
  const canShare = canManageWorkspaceSettings(ws);
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
      search: searchFromOpenItem({
        id: citation.fileId,
        kind: 'file',
        page: regionPage ?? citation.pageStart ?? undefined,
      }),
      to: '.',
    });
  }

  const [generating, setGenerating] = useState<GenerateMode | null>(null);
  const [chapterForm, setChapterForm] = useState<
    { mode: 'add' } | { mode: 'rename'; id: string; name: string } | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addSource, setAddSource] = useState<AddSourceMode | null>(null);

  if (wsLoading) {
    return (
      <LoadingLarge
        backLabel={m.workspace_back_to()}
        backTo="/workspaces"
        title={m.workspace_loading()}
      />
    );
  }

  if (!ws) {
    const denied =
      isApiError(wsErr) && (wsErr.status === 404 || wsErr.status === 401);
    return (
      <WorkspaceError
        backLabel={m.workspace_back_to()}
        backTo="/workspaces"
        description={
          denied ? m.error_private_body() : m.workspace_missing_body()
        }
        title={denied ? m.error_private_title() : m.workspace_unable_load()}
      />
    );
  }

  // Chat is open to every signed-in role; generation stays edit-only.
  const panelTabs: PanelTab[] = readOnly
    ? ['files', 'chat']
    : ['files', 'chat', 'generate'];
  const railTabs =
    layout === 'three' ? panelTabs.filter((t) => t !== 'files') : panelTabs;
  // Files lives on the left when pinned, and Generate is gone for a read-only
  // visitor: either way the rail falls back to Chat.
  const railTab: PanelTab = railTabs.includes(tab) ? tab : 'chat';
  const tabLabel = (t: PanelTab) =>
    t === 'files'
      ? m.workspace_tab_files()
      : t === 'chat'
        ? m.workspace_tab_chat()
        : m.workspace_tab_generate();
  function showTab(next: PanelTab) {
    setTab(next);
    if (layout === 'one') setToolsOpen(true);
  }

  const rowProps = {
    compact: layout === 'one',
    onOpenSettings: canShare ? () => setSettingsOpen(true) : undefined,
  };
  const addProps = readOnly
    ? {}
    : {
        onAddChapter: () => setChapterForm({ mode: 'add' }),
        onAddSource: setAddSource,
      };
  const tabs = (
    <Tabs
      className="min-w-0 flex-1 shrink"
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
      beforeReplace={confirmViewerReplacement}
      generating={generating}
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
  // Every tab stays mounted so chat and generate keep their state while hidden;
  // only the visible one draws the tab row.
  const noRow = () => null;
  const rail = (
    <>
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
            readOnly={readOnly}
            renderTabRow={railTab === 'chat' ? railRow : noRow}
            workspaceId={workspaceId}
          />
        </AppErrorBoundary>
      </div>
      {!readOnly && (
        <div className="min-h-0 flex-1" hidden={railTab !== 'generate'}>
          <GeneratePanel
            canReprocess={ws.isOwner}
            chapters={chapters ?? []}
            existingTitles={(materials ?? []).map((mt) => mt.title)}
            files={files ?? []}
            onGeneratingChange={setGenerating}
            onOpenItem={setOpenItem}
            renderTabRow={railTab === 'generate' ? railRow : noRow}
            workspaceId={workspaceId}
            workspaceName={ws.name}
          />
        </div>
      )}
    </>
  );

  const viewer = (
    <Panel className="w-full" sectionClassName="h-full gap-0">
      <h1 className="sr-only">{ws.name}</h1>
      <StorageOwnerBanner workspace={ws} />
      <AppErrorBoundary resetKeys={[openItem?.kind, openItem?.id]}>
        <CenterContent
          beforeFileDelete={confirmViewerReplacement}
          chapters={chapters ?? []}
          color="purple"
          item={openItem}
          leading={
            <>
              <div className="mr-1 flex items-center gap-1">
                <IconButton
                  className="px-1 text-fg-muted"
                  icon="navigationBack"
                  label={m.workspace_back_to()}
                  onClick={() => navigate({ to: '/workspaces' })}
                  size="sm"
                  tooltip
                  variant="ghost-hover"
                />
                {xl && (
                  <IconButton
                    aria-pressed={pinned}
                    className="px-1 text-fg-muted"
                    icon="panelLeft"
                    label={
                      pinned
                        ? m.workspace_unpin_files()
                        : m.workspace_pin_files()
                    }
                    onClick={togglePinned}
                    size="sm"
                    tooltip
                    variant="ghost-hover"
                  />
                )}
              </div>
              <WorkspaceMenu
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
            </>
          }
          onDeleted={() => setOpenItem(null)}
          onFileViewerDirtyChange={setOfficeEditDirty}
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

  // overflow-visible WITH important is so that shadow doesnt get clipped
  return (
    <>
      {layout === 'one' ? (
        <div className="flex h-full min-h-0 flex-col gap-2.5">
          <TopInsetBar className="w-full" />
          <div className="relative min-h-0 flex-1">
            {viewer}
            {!toolsOpen && (
              <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 gap-0.5 rounded-full border border-line bg-surface p-1 shadow-pop">
                {panelTabs.map((t) => (
                  <Button
                    className="h-9 rounded-full px-3.5"
                    iconLeft={TAB_ICON[t]}
                    key={t}
                    onClick={() => showTab(t)}
                    size="sm"
                    variant="ghost-hover"
                  >
                    {tabLabel(t)}
                  </Button>
                ))}
              </div>
            )}
          </div>
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
        </div>
      ) : (
        <ResizablePanelGroup
          className="overflow-visible! flex h-full min-h-0 gap-1.5"
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
                      {...rowProps}
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
            minSize="400px"
          >
            {viewer}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            className="overflow-visible!"
            defaultSize={xl ? '400px' : '340px'}
            id="rail"
            maxSize={xl ? '600px' : '420px'}
            minSize={xl ? '320px' : '300px'}
          >
            {railColumn}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
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
          open
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}
