import {
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useRouter,
  useSearch,
} from '@tanstack/react-router';
import {
  type ComponentProps,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isMaterialContentUnreadable, qk } from '@/api/client';
import {
  useFile,
  useMaterial,
  useMaterials,
  useRecordOpen,
  useWorkspaceRecent,
} from '@/api/hooks';
import type {
  Chapter,
  Material,
  MaterialListItem,
  MaterialPage,
  Provenance,
  Region,
  UserColor,
} from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { PreviewCard } from '@/components/app/PreviewCard';
import { TabContent } from '@/components/app/tabPanel';
import { BannerStack, FileBanner } from '@/components/banners/FileBanner';
import { Button } from '@/components/ui/Button';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { NoteSeat, NoteSeatContext } from '@/features/collaboration/noteSeat';
import {
  createPresenceStore,
  type PresenceConnection,
} from '@/features/collaboration/presence';
import {
  recentIcon,
  recentThumbnail,
} from '@/features/dashboard/RecentItemsCard';
import {
  mergeRecentItems,
  type RecentItem,
} from '@/features/dashboard/recentItems';
import {
  FileError,
  FileLoading,
  FileNotIndexedBanner,
  StorageFullBanner,
} from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import {
  EditorStatusContext,
  FileActionsTarget,
  FileHeaderTarget,
  FileMenuShown,
  FileMenuTarget,
  FileModeContext,
  PresenceContext,
} from '@/features/files/fileModeContext';
import { fileIsIngesting, IMAGE_MIN_ZOOM } from '@/features/files/fileUtils';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import { FlashcardGrid } from '@/features/flashcards/FlashcardGrid';
import { LiveFlashcards } from '@/features/flashcards/LiveFlashcards';
import { useLiveSetCards } from '@/features/flashcards/liveReads';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { handOverLiveNote } from '@/features/notes/liveNoteHandover';
import { NoteDisplayToggles } from '@/features/notes/NoteDisplayToggles';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import type { LearnerQuestion } from '@/features/questions/types';
import { useLiveQuizQuestions } from '@/features/quizzes/liveQuizReads';
import { QuizEditor } from '@/features/quizzes/QuizEditor';
import { QuizQuestionList } from '@/features/quizzes/QuizPage';
import {
  OfflineStatus,
  WorkspaceStatusButton,
} from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { useMediaQuery } from '@/lib/useMediaQuery';
import {
  createEditorStatusStore,
  EditorStatusStoreContext,
  FilesTitleButton,
  Header,
  type OneColumnChrome,
} from './CenterContentHeader';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
  type MaterialDocument,
  type MaterialValue,
  parseMaterialDocument,
  type QuizElement,
} from './document';
import { HeavyMaterialGate } from './HeavyMaterialGate';
import { type HeavyMaterialChoice, heavyMaterial } from './heavyDocument';
import {
  MaterialAttributionFooter,
  SourcesLine,
} from './MaterialAttributionFooter';
import { RemovedAssetsContext, useRemovedAssets } from './MediaAssetView';
import { MermaidMaterialView } from './MermaidMaterialView';
import {
  type MaterialMode,
  materialModePolicy,
  resolveMaterialMode,
} from './modePolicy';
import { showNoteCitation } from './noteCitation';
import { type OpenItem, readDocumentMode, saveDocumentMode } from './openItem';
import { embedKey, useNoteFooter } from './useNoteFooter';

/* Interactive Plate is the heaviest chunk in this route. View mode
 * deliberately never loads it. */
const NoteEditor = lazy(() =>
  import('@/features/notes/NoteEditor').then((m) => ({
    default: m.NoteEditor,
  }))
);

/* A standalone mindmap's or diagram's live editor: CodeMirror, no Plate. */
const MermaidMaterialEditor = lazy(
  () => import('@/features/notes/blocks/MermaidMaterialEditor')
);

/* Static Plate preview is still heavy — keep it out of the PDF / media path. */
let previewModule: typeof import('./MaterialPreview') | undefined;
const loadPreview = () =>
  import('./MaterialPreview').then((module) => {
    previewModule = module;
    return module;
  });
const LazyMaterialPreview = lazy(() =>
  loadPreview().then((m) => ({ default: m.MaterialPreview }))
);
const StudyPage = lazy(() =>
  import('@/features/study/StudyPage').then((mod) => ({
    default: mod.StudyPage,
  }))
);
type PreviewComponent =
  | typeof LazyMaterialPreview
  | typeof import('./MaterialPreview').MaterialPreview;

/** The center pane. Dispatches on the currently-open item — a source file or a
 * study material — and renders a consistent header plus the item body. Quiz and
 * flashcards materials get view actions in the header; mindmaps/diagrams render inline.
 * User-authored notes take over the whole pane with the editable Plate editor. */
export function CenterContent({
  chapters,
  item,
  readOnly = false,
  color,
  onDeleted,
  onAddFile,
  onModeChange,
  onOpenSettings,
  onOpenItem,
  onOpenProgress,
  plan,
  study = false,
  requestedMode = null,
  workspaceId,
  leading,
  trailing,
  oneColumn,
  standalone = false,
}: {
  /** Opens an item from the Study page or a plan. */
  onOpenItem?: (item: OpenItem) => void;
  /** Opens the Study page; a quick action when no file is open. */
  onOpenProgress?: () => void;
  /** The Study page's picked plan. */
  plan?: string;
  /** Shows the Study page while no file is open. */
  study?: boolean;
  /** Below lg: the title opens Files and ⋮ carries the workspace actions. */
  oneColumn?: OneColumnChrome;
  standalone?: boolean;
  /** Workspace chrome drawn before the file name in the header. */
  leading?: ReactNode;
  /** Workspace chrome at the header's right end. */
  trailing?: ReactNode;
  chapters: Chapter[];
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
  onDeleted: () => void;
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
  // Full screen lives in the URL (`?fullscreen=true`) so the back gesture
  // leaves it; opening another item drops it with the rest of the search.
  const isFullscreen =
    useSearch({ select: (search) => search.fullscreen, strict: false }) ===
    true;
  const navigate = useNavigate();
  const router = useRouter();
  // Set when this pane pushed the entry: leaving pops it, so back afterwards
  // does not land on the same page again. A loaded full screen URL replaces.
  const pushedFullscreen = useRef(false);
  const setFullscreen = useCallback(
    (on: boolean) => {
      if (!on && pushedFullscreen.current) {
        pushedFullscreen.current = false;
        router.history.back();
        return;
      }
      pushedFullscreen.current = on;
      void navigate({
        replace: !on,
        search: (previous) => ({
          ...previous,
          fullscreen: on ? (true as const) : undefined,
        }),
        to: '.',
      });
    },
    [navigate, router]
  );
  const [editorStatus] = useState(createEditorStatusStore);
  // Stable: the store's own setter, so reporting never re-renders this pane.
  const setEditorStatus = editorStatus.getState().report;
  // The open room's other editors, for the header's avatar group.
  const [presence] = useState(createPresenceStore);
  const setPresence = presence.getState().report;
  // An Office file's menus reached the header: its second row shows.
  const [menuShown, setMenuShown] = useState(false);

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setEditorStatus(null);
    setPresence(null);
    setMenuShown(false);
  }, [item?.kind, item?.id]);

  // Escape leaves full screen unless something open (a menu, a dialog)
  // already took it.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented)
        setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen, setFullscreen]);

  useEffect(() => {
    if (item && requestedMode) saveDocumentMode(item, requestedMode);
  }, [item?.kind, item?.id, requestedMode]);

  // Each open orders Recent Files and the quick open (the hook sends at most
  // one per item per few minutes).
  const recordOpen = useRecordOpen();
  const openKind = item?.kind;
  const openId = item?.id;
  useEffect(() => {
    if (openKind && openId) recordOpen({ id: openId, kind: openKind });
  }, [openKind, openId, recordOpen]);

  const changeMaterialMode = (nextMode: MaterialMode) => {
    setEditorStatus(null);
    setPresence(null);
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
        onOpenItem={onOpenItem}
        onOpenProgress={onOpenProgress}
        onOpenSettings={onOpenSettings}
        plan={plan}
        study={study}
        trailing={trailing}
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
                <PresenceContext.Provider value={setPresence}>
                  <FileMenuShown.Provider value={setMenuShown}>
                    <div
                      className={cn(
                        // Only fullscreen needs its own fill; in the panel the
                        // panel's shows through, frosted or not. Fixed, it
                        // covers both side panels without closing them.
                        'flex min-h-0 flex-1 flex-col',
                        isFullscreen && 'fixed inset-0 z-40 bg-surface'
                      )}
                    >
                      {/* Hidden, not unmounted: the file's controls portal
                       * into the header's slots. */}
                      <div className={isFullscreen ? 'hidden' : 'contents'}>
                        <Header
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
                            <span
                              className="flex items-center"
                              ref={setFileHeader}
                            />
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
                          menuShown={menuShown}
                          onDeleted={onDeleted}
                          oneColumn={oneColumn}
                          onImageZoomChange={setImageZoom}
                          onMaterialModeChange={changeMaterialMode}
                          onToggleFullscreen={() =>
                            setFullscreen(!isFullscreen)
                          }
                          presence={presence}
                          readOnly={readOnly}
                          standalone={standalone}
                          trailing={trailing}
                          workspaceId={workspaceId}
                        />
                      </div>
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
                            <MaterialBody
                              allowExternalAssets={!readOnly}
                              centerQuiz={!standalone}
                              citation={item.citation}
                              key={item.id}
                              materialId={item.id}
                              mode={materialMode}
                              onEditorStatusChange={setEditorStatus}
                              onPresenceChange={setPresence}
                              readOnly={readOnly}
                              target={item.target}
                              workspaceId={workspaceId}
                            />
                          )}
                          {item.kind === 'file' && (
                            <FileBody
                              citation={item.citation}
                              color={color}
                              fileId={item.id}
                              imageZoom={imageZoom}
                              key={item.id}
                              onImageZoomChange={setImageZoom}
                              page={item.page}
                              regions={item.regions}
                            />
                          )}
                        </div>
                      </BannerStack>
                    </div>
                  </FileMenuShown.Provider>
                </PresenceContext.Provider>
              </EditorStatusStoreContext.Provider>
            </EditorStatusContext.Provider>
          </FileActionsTarget.Provider>
        </FileMenuTarget.Provider>
      </FileHeaderTarget.Provider>
    </FileModeContext.Provider>
  );
}

/** The kind a cached material list (a Files page or the quick open) gives a
 * standalone material, so a read that fails can still name it. */
function listedKind(queryClient: QueryClient, id: string) {
  for (const [, data] of queryClient.getQueriesData<
    InfiniteData<MaterialPage> | MaterialListItem[]
  >({ queryKey: qk.ownedMaterialsRoot })) {
    const rows = Array.isArray(data)
      ? data
      : (data?.pages.flatMap((page) => page.items) ?? []);
    const hit = rows.find((item) => item.id === id);
    if (hit) return hit.kind;
  }
}

const UNREADABLE_TITLES: Partial<Record<Material['kind'], () => string>> = {
  flashcards: m.material_decode_flashcards_title,
  quiz: m.material_decode_quiz_title,
};

/** Gates the fetch on a confirmation when the list metadata says the document
 * is heavy. The weight comes from the already-cached material list, so nothing
 * of the document itself is downloaded before the reader chooses. Keyed by
 * material id at the call site: resetting the choice in an effect would let the
 * next document start fetching for the render before the reset lands. */
function MaterialBody({
  centerQuiz,
  citation,
  materialId,
  workspaceId,
  mode,
  allowExternalAssets,
  onEditorStatusChange,
  onPresenceChange,
  readOnly,
  target,
}: {
  centerQuiz: boolean;
  citation?: OfficeCitation;
  materialId: string;
  workspaceId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  onPresenceChange: (connections: PresenceConnection[] | null) => void;
  readOnly: boolean;
  target?: string;
}) {
  const { data: materials, isPending } = useMaterials(workspaceId);
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<HeavyMaterialChoice | null>(null);

  // Wait for the list before deciding. Rendering first and gating afterwards
  // would download the very document the gate exists to avoid, then throw the
  // mounted editor away.
  if (workspaceId && isPending) return <FileLoading />;

  const reference = materials?.find((entry) => entry.id === materialId);
  const heavy = heavyMaterial(reference);
  if (heavy && !choice) {
    return (
      <HeavyMaterialGate
        material={heavy}
        onChoose={setChoice}
        title={reference?.title ?? 'This note'}
      />
    );
  }

  return (
    <MaterialContent
      allowExternalAssets={allowExternalAssets}
      centerQuiz={centerQuiz}
      citation={citation}
      forceReadOnly={readOnly || choice === 'readOnly'}
      key={materialId}
      kind={reference?.type ?? listedKind(queryClient, materialId)}
      materialId={materialId}
      mode={mode}
      onEditorStatusChange={onEditorStatusChange}
      onPresenceChange={onPresenceChange}
      staticNote={choice === 'readOnly'}
      target={target}
    />
  );
}

/** Shows a chat citation's passage in the note beside it. Each click brings
 * a new citation object, so a repeat scrolls and flashes again. */
function NoteCitation({ citation }: { citation: OfficeCitation }) {
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const scroller = anchor.current?.parentElement;
    return scroller ? showNoteCitation(scroller, citation.quote) : undefined;
  }, [citation]);
  return <span hidden ref={anchor} />;
}

/** A set's View: the stored cards, then the room's as they change. */
function LiveSetGrid({
  material,
  action,
  openCardId,
}: {
  material: Material;
  action: ReactNode;
  /** A card to open at once (a link to it). */
  openCardId?: string;
}) {
  const stored = flashcardsElementToCards(
    material.content.value.find(
      (node): node is FlashcardsElement => node.type === 'flashcards'
    ) ?? { children: [], id: '', type: 'flashcards' }
  );
  const cards = useLiveSetCards(material.id, stored);
  return (
    <FlashcardGrid
      action={action}
      cards={cards}
      openCardId={openCardId}
      title={material.title}
    />
  );
}

/** The material's view or editor. Every media block in it knows the images
 * and audio it shows that are gone (deleted by their uploader, M16) and shows
 * them as removed; an embedded quiz or set provides its own (AppEmbed). */
export function MaterialContent(
  props: ComponentProps<typeof MaterialContentBody>
) {
  const { data, refetch } = useMaterial(props.materialId, {
    errorBoundary: false,
  });
  const removed = useRemovedAssets(data?.removedAssetIds, refetch);
  return (
    <RemovedAssetsContext.Provider value={removed}>
      <MaterialContentBody {...props} />
    </RemovedAssetsContext.Provider>
  );
}

function MaterialContentBody({
  centerQuiz,
  kind,
  materialId,
  mode,
  allowExternalAssets,
  forceReadOnly,
  onEditorStatusChange,
  onPresenceChange,
  staticNote = false,
  target,
  citation,
}: {
  centerQuiz: boolean;
  /** The kind the opening list or route knows, for a read that fails. */
  kind?: Material['kind'];
  materialId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  forceReadOnly: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  /** The room's other editors, for the header's avatar group. */
  onPresenceChange?: (connections: PresenceConnection[] | null) => void;
  /** A heavy note opened read-only: View paints the projection and never
   * joins the room, as the gate promises (REVIEW5 S3). */
  staticNote?: boolean;
  /** A question or card to bring into view once the material shows. */
  target?: string;
  /** A chat citation's passage to show once a note paints (Q593). */
  citation?: OfficeCitation;
}) {
  const {
    data: material,
    error,
    isLoading,
  } = useMaterial(materialId, {
    errorBoundary: false,
  });
  // The open room turned read-only (a frozen account, an owner at its storage
  // limit, a block this version cannot edit): view mode under a grey strip
  // saying why; unsaved edits are discarded.
  const [readOnly, setReadOnly] = useState<ReadOnlyCode | 'access' | null>(
    null
  );
  const onReadOnly = useCallback(
    (code?: ReadOnlyCode) => setReadOnly(code ?? 'access'),
    []
  );
  const overBar = useContext(FloatingBarContext);
  useEffect(() => {
    if (mode === 'edit') void loadPreview();
  }, [mode]);
  const previewType = useRef<PreviewComponent>(undefined);
  if (isLoading) {
    return <FileLoading />;
  }
  if (error || !material) {
    return isMaterialContentUnreadable(error) ? (
      <FileError
        message={m.material_decode_body()}
        title={
          (kind && UNREADABLE_TITLES[kind]?.()) ?? m.material_decode_title()
        }
      />
    ) : (
      <FileError />
    );
  }
  const policy = materialModePolicy(material.capabilities);
  const activeMode =
    forceReadOnly || readOnly ? 'view' : resolveMaterialMode(mode, policy);
  // Its payer (whoever created it) at the storage limit opens it view-only
  // under a strip saying so (uploader pays).
  const readOnlyStrip = material.storageFull ? (
    <StorageFullBanner by={material.storageFull} />
  ) : (
    readOnly && (
      <FileBanner
        message={
          readOnly === 'unsupported_block'
            ? m.editor_unsupported_block_strip()
            : m.editor_read_only_strip()
        }
      />
    )
  );
  // Edit to View shows the note at once (NoteEditorCore hands over its live
  // value), so View must not suspend on loading its renderer: Edit loads it,
  // and View then renders it directly. The type is chosen once per mount, at
  // the first View: swapping the lazy wrapper for the loaded component later
  // would remount the whole document (frames reload, quiz attempts reset).
  if (activeMode === 'view')
    previewType.current ??=
      previewModule?.MaterialPreview ?? LazyMaterialPreview;
  const MaterialPreview = previewType.current ?? LazyMaterialPreview;

  if (material.kind === 'quiz' && activeMode === 'edit') {
    return (
      <div className="h-full min-h-0 overflow-auto">
        <TabContent fill>
          <QuizEditor
            action={<StudyButton kind="quiz" materialId={materialId} />}
            key={materialId}
            onPresenceChange={onPresenceChange}
            onStatusChange={onEditorStatusChange}
            quizId={materialId}
            title={material.title}
          />
          <SourcesLine
            className={cn('mt-16 pb-4', overBar && 'pb-20')}
            provenance={material.provenance}
          />
        </TabContent>
      </div>
    );
  }
  if (material.kind === 'flashcards') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <TabContent centered={centerQuiz}>
            {activeMode === 'edit' ? (
              <LiveFlashcards
                action={
                  <StudyButton kind="flashcards" materialId={materialId} />
                }
                onPresenceChange={onPresenceChange}
                onStatusChange={onEditorStatusChange}
                setId={materialId}
                title={material.title}
              />
            ) : (
              <LiveSetGrid
                action={
                  <StudyButton kind="flashcards" materialId={materialId} />
                }
                material={material}
                openCardId={target}
              />
            )}
            <SourcesLine
              className={cn('mt-16 pb-4', overBar && 'pb-20')}
              provenance={material.provenance}
            />
          </TabContent>
        </div>
      </div>
    );
  }

  if (
    (material.kind === 'mindmap' || material.kind === 'diagram') &&
    activeMode === 'edit'
  )
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AppErrorBoundary resetKeys={[materialId, activeMode]}>
          <Suspense fallback={<FileLoading />}>
            <MermaidMaterialEditor
              kind={material.kind}
              materialId={materialId}
              onPresenceChange={onPresenceChange}
              onReadOnly={onReadOnly}
              onStatusChange={onEditorStatusChange}
              provenance={material.provenance}
              title={material.title}
            />
          </Suspense>
        </AppErrorBoundary>
      </div>
    );
  if (
    (material.kind === 'mindmap' || material.kind === 'diagram') &&
    activeMode === 'view'
  )
    return (
      <div className="flex h-full min-h-0 flex-col">
        {readOnlyStrip}
        <div className="min-h-0 flex-1 overflow-auto">
          <MermaidMaterialView
            content={material.content}
            material={{
              isStandalone: !material.workspaceId,
              kind: material.kind,
              title: material.title,
            }}
          />
          <DocumentAttribution material={material} />
        </div>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {readOnlyStrip}
      <div className="min-h-0 flex-1">
        {activeMode === 'view' && (
          <div className="relative h-full min-h-0 overflow-auto">
            {material.kind === 'note' && <NoteDisplayToggles />}
            {material.kind === 'note' && citation ? (
              <NoteCitation citation={citation} />
            ) : null}
            {material.kind === 'quiz' ? (
              <QuizPreview
                content={material.content}
                provenance={material.provenance}
                quizId={materialId}
                target={target}
                title={material.title}
              />
            ) : (
              <Suspense fallback={<FileLoading />}>
                {material.kind === 'note' && !staticNote ? (
                  <LiveNotePreview
                    material={material}
                    Preview={MaterialPreview}
                  />
                ) : (
                  <MaterialPreview
                    content={material.content}
                    isStandalone={!material.workspaceId}
                    kind={material.kind}
                    title={material.title}
                  />
                )}
                <DocumentAttribution material={material} />
              </Suspense>
            )}
          </div>
        )}
        {activeMode === 'edit' && (
          <AppErrorBoundary resetKeys={[materialId, activeMode]}>
            <Suspense fallback={<FileLoading />}>
              <NoteEditor
                allowExternalAssets={allowExternalAssets}
                key={`${materialId}:${activeMode}`}
                materialId={materialId}
                onEditorStatusChange={onEditorStatusChange}
                onPresenceChange={onPresenceChange}
                onReadOnly={onReadOnly}
              />
            </Suspense>
          </AppErrorBoundary>
        )}
      </div>
    </div>
  );
}

/** A material's credits after its document, in the reading column the static
 * renderer uses for it, so View and Edit (NoteEditorCore) end alike: a note's
 * own and those of the embeds its content holds (useNoteFooter). Like every
 * footer ending a view here, it keeps room under the workspace's floating bar
 * where that shows, and some space above the page's end. */
function DocumentAttribution({ material }: { material: Material }) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const overBar = useContext(FloatingBarContext);
  const embeds = useMemo(
    () => embedKey(material.content.value),
    [material.content]
  );
  const provenance = useNoteFooter(material, embeds);
  const { kind } = material;
  return (
    <MaterialAttributionFooter
      className={cn(
        'mx-auto w-full px-5 sm:px-10',
        overBar ? 'pb-28' : 'pb-12',
        (kind !== 'note' || displayWidth === 'half') && 'md:max-w-3xl'
      )}
      inline
      provenance={provenance}
    />
  );
}

/** A note's View (Epo 2026-10-10): the projection paints first; then the
 * live-read module loads, outside the first paint and every other bundle, and
 * the note follows its room on a read channel. The room's value replaces the
 * painted one block by block, keeping each block the room has not changed, so
 * nothing flashes and a remote keystroke redraws one block. */
function LiveNotePreview({
  material,
  Preview,
}: {
  material: Material;
  Preview: PreviewComponent;
}) {
  const painted = useMemo<MaterialValue>(
    () =>
      parseMaterialDocument(material.content)?.value ?? material.content.value,
    [material.content]
  );
  const [live, setLive] = useState<MaterialValue | null>(null);
  const first = useRef(painted);
  first.current = painted;
  // The note's read channel, inside which its embeds join (Epo 2026-10-20).
  const [seat] = useState(() => new NoteSeat());
  useEffect(() => {
    setLive(null);
    let leave: (() => void) | undefined;
    let gone = false;
    const timer = setTimeout(() => {
      void import('@/features/notes/liveNoteRead').then(({ readNoteLive }) => {
        if (!gone)
          leave = readNoteLive(material.id, first.current, setLive, seat);
      });
    });
    return () => {
      gone = true;
      clearTimeout(timer);
      leave?.();
    };
  }, [material.id, seat]);
  return (
    <NoteSeatContext.Provider value={seat}>
      <Preview
        content={material.content}
        isStandalone={!material.workspaceId}
        kind={material.kind}
        title={material.title}
        value={live ?? painted}
      />
    </NoteSeatContext.Provider>
  );
}

/** A quiz reads exactly like the quiz page, without taking answers. Its
 * questions come from the material already loaded, so this works offline.
 * Material reads carry learner questions with no answer key; only the quiz
 * editor loads the key. */
function QuizPreview({
  content,
  provenance,
  quizId,
  target,
  title,
}: {
  content: MaterialDocument;
  provenance: Provenance | undefined;
  quizId: string;
  /** A question to scroll to, e.g. from a review summary. */
  target?: string;
  title: string;
}) {
  const overBar = useContext(FloatingBarContext);
  useEffect(() => {
    if (!target) return;
    document
      .querySelector(`[data-question-id="${CSS.escape(target)}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [target]);
  const quiz = content.value.find(
    (node): node is QuizElement => node.type === 'quiz'
  );
  const stored = (quiz?.children ?? []).flatMap((node) =>
    'type' in node && node.type === 'quiz_question'
      ? [node.question as unknown as LearnerQuestion]
      : []
  );
  // The stored questions paint first; the live room follows (live-items).
  const questions = useLiveQuizQuestions(quizId, stored);
  return (
    <TabContent fill>
      <div className="mb-7 flex items-center gap-4">
        <h1 className="t-large-card-title min-w-0 flex-1">{title}</h1>
        <StudyButton kind="quiz" materialId={quizId} />
      </div>
      <QuizQuestionList disabled questions={questions} />
      <SourcesLine
        className={cn('mt-16 pb-4', overBar && 'pb-20')}
        provenance={provenance}
      />
    </TabContent>
  );
}

/** Study: a quiz's attempt or a set's study session, in View and Edit. */
function StudyButton({
  kind,
  materialId,
}: {
  kind: 'quiz' | 'flashcards';
  materialId: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      className="shrink-0"
      onClick={() =>
        kind === 'quiz'
          ? navigate({
              params: { quizId: materialId },
              to: '/quizzes/$quizId/attempt',
            })
          : navigate({
              params: { flashcardSetId: materialId },
              to: '/flashcards/$flashcardSetId',
            })
      }
      size="md"
      variant="dark"
    >
      {m.action_study()}
    </Button>
  );
}

/** No file open: the header row keeps the workspace picker, then the offline
 * and workspace status icons. No strip renders, since strips belong to a file. */
function EmptyCenter({
  leading,
  trailing,
  oneColumn,
  onAddFile,
  onOpenItem,
  onOpenProgress,
  onOpenSettings,
  plan,
  study,
  workspaceId,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
  oneColumn?: OneColumnChrome;
  onAddFile?: () => void;
  onOpenItem?: (item: OpenItem) => void;
  onOpenProgress?: () => void;
  onOpenSettings?: () => void;
  plan?: string;
  study?: boolean;
  workspaceId: string;
}) {
  const sm = useMediaQuery('(min-width: 640px)');
  const menuItems = oneColumn
    ? [...oneColumn.addItems, ...oneColumn.settingsItems]
    : [];
  return (
    <>
      <div
        className={cn(
          'flex h-12 items-center gap-1 border-divider border-b sm:h-15',
          // Workspace buttons at the edges sit as far in as a file header's.
          leading ? 'px-3' : 'px-2 sm:px-4',
          // As in a file header: the title pill's padding spaces it.
          !(leading && oneColumn) && 'sm:gap-2'
        )}
        data-slot="center-header"
      >
        {leading ?? (
          <>
            <Icon className="size-5.5" name="files" />
            <h2 className="t-subtitle translate-y-px truncate">--</h2>
          </>
        )}
        {oneColumn && (
          // Pulled in to a 10px ink gap after the back arrow, as in a file's.
          <h2
            className={cn('t-body min-w-0 font-semibold', leading && '-ml-2')}
          >
            <FilesTitleButton chrome={oneColumn}>
              {/* Sized as an open file's icon in the same spot. */}
              <img
                alt=""
                className="size-4.5 shrink-0 rounded-[4px] md:size-5"
                src={iconUrl(oneColumn.workspaceIconId)}
              />
              <span className="min-w-0 truncate">
                {oneColumn.workspaceName}
              </span>
            </FilesTitleButton>
          </h2>
        )}
        {!(oneColumn && !sm) && (
          <>
            <OfflineStatus />
            <WorkspaceStatusButton />
          </>
        )}
        {(menuItems.length > 0 || trailing) && (
          <div className="ml-auto flex items-center">
            {menuItems.length > 0 && (
              <Menu
                items={menuItems}
                trigger={
                  <ToolbarButton label={m.a11y_open_menu()}>
                    <Icon name="moreVertical" />
                  </ToolbarButton>
                }
              />
            )}
            {trailing}
          </div>
        )}
      </div>
      {(plan || study) && workspaceId && onOpenItem ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <Suspense fallback={null}>
            <StudyPage
              onOpenItem={onOpenItem}
              planId={plan}
              workspaceId={workspaceId}
            />
          </Suspense>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center p-4 sm:p-6">
          {workspaceId ? (
            <RecentInWorkspace
              actions={
                <QuickActions
                  onOpenProgress={onOpenProgress}
                  onOpenSettings={onOpenSettings}
                />
              }
              onAddFile={onAddFile}
              workspaceId={workspaceId}
            />
          ) : (
            <PickAFile />
          )}
        </div>
      )}
    </>
  );
}

function PickAFile({ actions }: { actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <Icon className="non-scaling-svg size-8" name="files" />
      <p>{m.material_select()}</p>
      {actions && <div className="mt-6">{actions}</div>}
    </div>
  );
}

/** Workspace shortcuts under the recent files: as tall as a file tree row,
 * muted until hovered. */
function QuickActions({
  onOpenProgress,
  onOpenSettings,
}: {
  onOpenProgress?: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="flex flex-col items-start">
      {onOpenSettings && (
        <Button
          className="h-8 px-3 text-xs"
          iconLeft="settings"
          onClick={onOpenSettings}
          size="sm"
          variant="ghost-muted"
        >
          {m.workspace_settings()}
        </Button>
      )}
      <Button
        className="h-8 px-3 text-xs"
        iconLeft="knowledge"
        onClick={onOpenProgress}
        size="sm"
        variant="ghost-muted"
      >
        {m.workspace_study_plan()}
      </Button>
    </div>
  );
}

/** The workspace's four newest files and materials as cards for a quick
 * open. Blank while loading; an empty workspace gets a dashed add file card
 * instead, or the plain prompt when the viewer cannot add. */
function RecentInWorkspace({
  actions,
  onAddFile,
  workspaceId,
}: {
  actions: ReactNode;
  onAddFile?: () => void;
  workspaceId: string;
}) {
  const { data, isLoading } = useWorkspaceRecent(workspaceId);
  if (isLoading) return null;
  const items = mergeRecentItems(
    data?.files ?? [],
    data?.materials ?? [],
    [],
    4
  );
  if (!items.length && !onAddFile) return <PickAFile actions={actions} />;
  const single = items.length <= 1;
  return (
    // Lifted by half the subtitle row so the grid, not the block, sits centred.
    <div className="flex w-full max-w-[400px] -translate-y-4 flex-col gap-2.5">
      <h3 className="t-subtitle px-1">{m.dashboard_recent()}</h3>
      <div
        className={cn(
          'grid gap-1',
          // A lone card keeps its two-column width, centred.
          single ? 'grid-cols-[calc(50%-2px)] justify-center' : 'grid-cols-2'
        )}
      >
        {items.map((item) => (
          <QuickOpenCard
            item={item}
            key={`${item.kind}-${item.id}`}
            workspaceId={workspaceId}
          />
        ))}
        {!items.length && onAddFile && <AddFileCard onClick={onAddFile} />}
      </div>
      <div className="mt-6">{actions}</div>
    </div>
  );
}

/** The empty workspace's only card: a dashed tile the size of a preview,
 * as the dashed new workspace card on Workspaces. */
function AddFileCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="cursor-pointer rounded-[calc(var(--radius-tile)+1px)] p-1 outline-none focus-visible:ring-2 focus-visible:ring-action"
      onClick={onClick}
      type="button"
    >
      <span className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-[calc(var(--radius-tile)-1px)] text-fg-muted transition-colors hover:bg-surface-hover-bg">
        <Icon name="plus" size={20} />
        <span className="t-meta">{m.action_add_file()}</span>
      </span>
    </button>
  );
}

/** A Recent Files card: the shared preview card as a link to the item. */
function QuickOpenCard({
  item,
  workspaceId,
}: {
  item: RecentItem;
  workspaceId: string;
}) {
  return (
    <PreviewCard
      asChild
      icon={recentIcon(item)}
      thumbnail={recentThumbnail(item)}
      title={item.title}
    >
      <Link
        params={{ workspaceId }}
        preload="intent"
        search={
          item.kind === 'material' ? { material: item.id } : { file: item.id }
        }
        to="/workspaces/$workspaceId"
      />
    </PreviewCard>
  );
}

function FileBody({
  fileId,
  color,
  imageZoom,
  onImageZoomChange,
  page,
  regions,
  citation,
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
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
          onImageZoomChange={onImageZoomChange}
          page={page}
          regions={regions}
        />
      </div>
    </div>
  );
}
