import {
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Navigate,
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
  useRef,
  useState,
} from 'react';
import { isApiError, isMaterialContentUnreadable, qk } from '@/api/client';
import {
  useFile,
  useMaterial,
  useMaterials,
  useMe,
  useRecordOpen,
} from '@/api/hooks';
import type {
  Material,
  MaterialListItem,
  MaterialPage,
  Provenance,
  Region,
  Topic,
  UserColor,
} from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { TabContent } from '@/components/app/tabPanel';
import { BannerStack, FileBanner } from '@/components/banners/FileBanner';
import { Button } from '@/components/ui/Button';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  copyLabel,
  keepsCopyOf,
  type RoomCopy,
  useKeepMaterialCopy,
  useMaterialCopy,
  useRoomSeed,
} from '@/features/collaboration/deviceCopy';
import {
  createPresenceStore,
  type PresenceConnection,
} from '@/features/collaboration/presence';
import {
  FileError,
  FileLoading,
  FileNotIndexedBanner,
  StorageFullBanner,
  UnavailableItem,
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
import { unexpectedErrorId } from '@/lib/errors';
import { iconUrl } from '@/lib/icon-catalog';
import { useOnlineStatus } from '@/lib/online';
import { dropDeviceCopies } from '@/lib/sourceCache';
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
  type QuizElement,
} from './document';
import { HeavyMaterialGate } from './HeavyMaterialGate';
import { type HeavyMaterialChoice, heavyMaterial } from './heavyDocument';
import { SourcesLine } from './MaterialAttributionFooter';
import { RemovedAssetsContext, useRemovedAssets } from './MediaAssetView';
import { MermaidMaterialView } from './MermaidMaterialView';
import type { MaterialMode } from './modePolicy';
import {
  DocumentAttribution,
  loadPreview,
  NoteBody,
  NoteSkeleton,
} from './NoteBody';
import {
  type NoteCitationTarget,
  type OpenItem,
  readDocumentMode,
  saveDocumentMode,
} from './openItem';

/* A standalone mindmap's or diagram's live editor: CodeMirror, no Plate. */
const MermaidMaterialEditor = lazy(
  () => import('@/features/notes/blocks/MermaidMaterialEditor')
);

/* The static renderer of what is not a note (a note's is in NoteBody). */
const MaterialPreview = lazy(() =>
  loadPreview().then((module) => ({ default: module.MaterialPreview }))
);

/** The center pane. Dispatches on the currently-open item — a source file or a
 * study material — and renders a consistent header plus the item body. Quiz and
 * flashcards materials get view actions in the header; mindmaps/diagrams render inline.
 * User-authored notes take over the whole pane with the editable Plate editor. */
export function CenterContent({
  topics,
  item,
  readOnly = false,
  color,
  onDeleted,
  onModeChange,
  page,
  requestedMode = null,
  workspaceId,
  leading,
  oneColumn,
  standalone = false,
}: {
  /** The page shown under the header while no file is open: the
   * workspace's Dashboard or a Study page (one column; from lg the
   * workspace draws it without the header). */
  page?: ReactNode;
  /** Below lg: the title opens Files and ⋮ carries the workspace actions. */
  oneColumn?: OneColumnChrome;
  standalone?: boolean;
  /** Workspace chrome drawn before the file name in the header. */
  leading?: ReactNode;
  topics: Topic[];
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
  onDeleted: () => void;
  requestedMode?: MaterialMode | null;
  onModeChange: (mode: MaterialMode) => void;
  workspaceId: string;
}) {
  const [fileHeader, setFileHeader] = useState<HTMLSpanElement | null>(null);
  const [fileMenu, setFileMenu] = useState<HTMLSpanElement | null>(null);
  const [fileActions, setFileActions] = useState<HTMLSpanElement | null>(null);
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  // An Office or text file's: a material opens at the highest mode its reader
  // may have (Epo 2026-11-04).
  const fileMode =
    item?.kind === 'file' ? (requestedMode ?? readDocumentMode(item)) : 'view';
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
    if (item?.kind === 'file' && requestedMode)
      saveDocumentMode(item, requestedMode);
  }, [item?.kind, item?.id, requestedMode]);

  // Each open orders Recent Files and the quick open (the hook sends at most
  // one per item per few minutes).
  const recordOpen = useRecordOpen();
  const openKind = item?.kind;
  const openId = item?.id;
  useEffect(() => {
    if (openKind && openId) recordOpen({ id: openId, kind: openKind });
  }, [openKind, openId, recordOpen]);

  const changeFileMode = (nextMode: MaterialMode) => {
    setEditorStatus(null);
    setPresence(null);
    if (item?.kind === 'file') saveDocumentMode(item, nextMode);
    onModeChange(nextMode);
  };

  if (!item) {
    return (
      <EmptyCenter
        leading={leading}
        oneColumn={oneColumn}
        page={page}
        workspaceId={standalone ? '' : workspaceId}
      />
    );
  }
  return (
    <FileModeContext.Provider
      value={{ mode: fileMode, onChange: changeFileMode }}
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
                          onToggleFullscreen={() =>
                            setFullscreen(!isFullscreen)
                          }
                          presence={presence}
                          readOnly={readOnly}
                          standalone={standalone}
                          topics={topics}
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

/** A read the server refused. A rate limit, a timeout or a server error says
 * nothing about the item: such a read could not answer. */
const isRefusedRead = (error: unknown) =>
  isApiError(error) &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

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
  allowExternalAssets,
  onEditorStatusChange,
  onPresenceChange,
  readOnly,
  target,
}: {
  centerQuiz: boolean;
  citation?: NoteCitationTarget;
  materialId: string;
  workspaceId: string;
  allowExternalAssets: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  onPresenceChange: (connections: PresenceConnection[] | null) => void;
  readOnly: boolean;
  target?: string;
}) {
  const { data: materials, isPending } = useMaterials(workspaceId);
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<HeavyMaterialChoice | null>(null);
  const alreadyOpen = useRef(false);

  // Wait for the list before deciding. Rendering first and gating afterwards
  // would download the very document the gate exists to avoid, then throw the
  // mounted editor away.
  if (workspaceId && isPending) return <MaterialLoading />;

  const reference = materials?.find((entry) => entry.id === materialId);
  // A direct link to a quiz assigned to the reader opens the assignment. One
  // already open when it was assigned stays until they leave (Epo 2026-11-05).
  if (reference?.assignmentId && !alreadyOpen.current) {
    return (
      <Navigate
        params={{ workspaceId }}
        replace
        search={{
          assignment: reference.assignmentId,
          study: 'assignments' as const,
        }}
        to="/workspaces/$workspaceId"
      />
    );
  }
  if (reference) alreadyOpen.current = true;
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
      onEditorStatusChange={onEditorStatusChange}
      onPresenceChange={onPresenceChange}
      staticNote={choice === 'readOnly'}
      target={target}
    />
  );
}

/** Nothing to paint yet: a wordless skeleton (Epo 2026-11-04), or while offline
 * the one true thing to say (C9). */
function MaterialLoading() {
  const online = useOnlineStatus();
  return online ? <NoteSkeleton /> : <FileLoading />;
}

const storedCards = (material: Material) =>
  flashcardsElementToCards(
    material.content.value.find(
      (node): node is FlashcardsElement => node.type === 'flashcards'
    ) ?? { children: [], id: '', type: 'flashcards' }
  );

/** A quiz's questions as its read stored them: no answer key. */
const storedQuestions = (content: MaterialDocument) => {
  const quiz = content.value.find(
    (node): node is QuizElement => node.type === 'quiz'
  );
  return (quiz?.children ?? []).flatMap((node) =>
    'type' in node && node.type === 'quiz_question'
      ? [node.question as unknown as LearnerQuestion]
      : []
  );
};

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
  const cards = useLiveSetCards(material.id, storedCards(material));
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
  citation?: NoteCitationTarget;
}) {
  const {
    data: loaded,
    error,
    isPending,
    refetch,
  } = useMaterial(materialId, {
    errorBoundary: false,
  });
  // The open room turned read-only (a frozen account, an owner at its storage
  // limit, a block this version cannot edit): view mode under a grey strip
  // saying why; unsaved edits are discarded.
  const [readOnly, setReadOnly] = useState<ReadOnlyCode | 'access' | null>(
    null
  );
  const queryClient = useQueryClient();
  const onReadOnly = useCallback(
    (code?: ReadOnlyCode) => {
      // Read-only views draw the read, so it follows. A room's refusal asks for
      // none: only a refused read ends what shows.
      if (code !== 'access_lost')
        void queryClient.invalidateQueries({
          queryKey: qk.material(materialId),
        });
      setReadOnly(code ?? 'access');
    },
    [materialId, queryClient]
  );
  const overBar = useContext(FloatingBarContext);
  // The static renderer ahead of the paint, for a note or what may turn out to
  // be one: no other kind draws it.
  useEffect(() => {
    if (!kind || kind === 'note') void loadPreview();
  }, [kind]);
  const { data: me } = useMe({ errorBoundary: false });
  // A heavy note opened read-only reads nothing of its own beyond its read.
  const seed = useRoomSeed(materialId, staticNote ? null : me?.id);
  // An item's last read, painting until this one answers.
  const copied = useMaterialCopy(materialId, staticNote ? null : me?.id);
  const refused = isRefusedRead(error);
  // No access, or gone: what this device kept of it goes too.
  const lost =
    isApiError(error) && (error.status === 403 || error.status === 404);
  useEffect(() => {
    if (lost) void dropDeviceCopies(materialId);
  }, [lost, materialId]);
  // A refusal ends what shows; a read that could not answer leaves it, an open
  // editor included.
  const material = refused ? undefined : (loaded ?? copied ?? undefined);
  useKeepMaterialCopy(
    loaded?.kind === 'note' ? undefined : loaded,
    me?.id,
    copied
  );
  const noteBody = (loaded: Material | undefined, editing: boolean) => (
    <NoteBody
      allowExternalAssets={allowExternalAssets}
      citation={citation}
      editing={editing}
      material={loaded}
      materialId={materialId}
      onEditorStatusChange={onEditorStatusChange}
      onPresenceChange={onPresenceChange}
      onReadOnly={onReadOnly}
      owner={me?.id}
      seed={staticNote ? null : seed}
      staticNote={staticNote}
    />
  );
  // A device copy paints before its read answers, and while the read cannot
  // answer (the browser offline, the server down), until it refuses.
  // Keyed as the note below: the paint keeps its DOM as the read answers.
  if (!material && seed?.row.kind === 'note' && !refused)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1" key="note">
          {noteBody(undefined, false)}
        </div>
      </div>
    );
  if (isPending && !material) {
    // Nothing shows for the few milliseconds the store takes.
    if (me && (seed === undefined || copied === undefined)) return null;
    return <MaterialLoading />;
  }
  if (!material) {
    return isMaterialContentUnreadable(error) ? (
      <FileError
        message={m.material_decode_body()}
        title={
          (kind && UNREADABLE_TITLES[kind]?.()) ?? m.material_decode_title()
        }
      />
    ) : refused ? (
      <UnavailableItem />
    ) : (
      <FileError
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  // The highest mode this reader may have.
  const activeMode =
    !(forceReadOnly || readOnly) && material.capabilities.canEditContent
      ? 'edit'
      : 'view';
  // Refused by its room, an editor stays mounted and read-only, showing what it
  // holds rather than the older read (Epo 2026-11-05).
  const editorMounted = activeMode === 'edit' || readOnly === 'access_lost';
  const roomCopy: RoomCopy = {
    keep: me && keepsCopyOf(material) ? copyLabel(material, me.id) : undefined,
    seed,
  };
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
            : readOnly === 'access_lost'
              ? m.editor_access_lost()
              : m.editor_read_only_strip()
        }
      />
    )
  );
  if (material.kind === 'quiz' && activeMode === 'edit') {
    return (
      <QuizEditor
        action={<StudyButton kind="quiz" materialId={materialId} />}
        copy={roomCopy}
        key={materialId}
        onPresenceChange={onPresenceChange}
        onStatusChange={onEditorStatusChange}
        quizId={materialId}
        sources={
          <SourcesLine
            className={cn('pb-4', overBar && 'pb-20')}
            provenance={material.provenance}
          />
        }
        stored={storedQuestions(material.content)}
        target={target}
        title={material.title}
      />
    );
  }
  if (material.kind === 'flashcards') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {readOnly && readOnlyStrip}
        <div className="min-h-0 flex-1 overflow-auto">
          <TabContent centered={centerQuiz}>
            {editorMounted ? (
              <LiveFlashcards
                action={
                  <StudyButton kind="flashcards" materialId={materialId} />
                }
                copy={roomCopy}
                onPresenceChange={onPresenceChange}
                onReadOnly={onReadOnly}
                onStatusChange={onEditorStatusChange}
                openCardId={target}
                setId={materialId}
                stored={storedCards(material)}
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
    editorMounted
  )
    return (
      <div className="flex h-full min-h-0 flex-col">
        {readOnly && readOnlyStrip}
        <AppErrorBoundary resetKeys={[materialId, editorMounted]}>
          <Suspense fallback={<FileLoading />}>
            <MermaidMaterialEditor
              content={material.content}
              copy={roomCopy}
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
      <div className="min-h-0 flex-1" key="note">
        {material.kind === 'note' ? (
          noteBody(material, editorMounted)
        ) : (
          <div className="relative h-full min-h-0 overflow-auto">
            {material.kind === 'quiz' ? (
              <QuizPreview
                content={material.content}
                provenance={material.provenance}
                quizId={materialId}
                target={target}
                title={material.title}
              />
            ) : (
              <Suspense fallback={<MaterialLoading />}>
                <MaterialPreview
                  content={material.content}
                  isStandalone={!material.workspaceId}
                  kind={material.kind}
                  title={material.title}
                />
                <DocumentAttribution material={material} />
              </Suspense>
            )}
          </div>
        )}
      </div>
    </div>
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
  // Someone gone from editing to viewing keeps no answers on this device.
  useEffect(() => {
    void dropDeviceCopies(quizId, 'keys');
  }, [quizId]);
  // The stored questions paint first; the live room follows (live-items).
  const questions = useLiveQuizQuestions(quizId, storedQuestions(content));
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
 * and workspace status icons. No strip renders, since strips belong to a file.
 * `leading` null leaves the row's start empty (the rail carries Home). */
function EmptyCenter({
  leading,
  oneColumn,
  page,
  workspaceId,
}: {
  leading?: ReactNode;
  oneColumn?: OneColumnChrome;
  page?: ReactNode;
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
        {leading === undefined ? (
          <>
            <Icon className="size-5.5" name="files" />
            <h2 className="t-subtitle translate-y-px truncate">--</h2>
          </>
        ) : (
          leading
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
      {page && workspaceId ? (
        page
      ) : (
        <div className="grid flex-1 place-items-center p-4 sm:p-6">
          <PickAFile />
        </div>
      )}
    </>
  );
}

function PickAFile() {
  return (
    <div className="flex flex-col items-center gap-3">
      <Icon className="non-scaling-svg size-8" name="files" />
      <p>{m.material_select()}</p>
    </div>
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
    error,
    isLoading,
    isError,
  } = useFile(fileId, {
    errorBoundary: false,
  });
  if (isLoading) return <FileLoading />;
  // A refusal ends what shows, as a material's does (Epo 2026-11-05).
  if (isRefusedRead(error)) return <UnavailableItem />;
  if (!file && isError) return <FileError />;
  if (file && fileIsIngesting(file.status) && !file.hasBytes) {
    const waiting = file.status === 'pending';
    return (
      <div className="grid h-full place-items-center">
        <div className="flex w-64 -translate-y-1/2 flex-col items-center gap-3">
          <Icon className="non-scaling-svg size-7" name="ai" />
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
