import {
  hashKey,
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type ComponentProps,
  createContext,
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
import {
  type DeletedItem,
  deletedItemOf,
  isApiError,
  isMaterialContentUnreadable,
  qk,
} from '@/api/client';
import {
  materialTokenQuery,
  useFile,
  useMaterial,
  useMaterials,
  useMe,
  useRecordOpen,
} from '@/api/hooks';
import { answeredAt, freshAnswer } from '@/api/queryClient';
import type {
  ItemPage,
  Material,
  Provenance,
  Region,
  SourceFile,
  Topic,
  Trashed,
  UserColor,
} from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { TabContent } from '@/components/app/tabPanel';
import { BannerStack, FileBanner } from '@/components/banners/FileBanner';
import { DeletedDownload, SaveBanner } from '@/components/banners/SaveBanner';
import { PageButton } from '@/components/ui/Button';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { Menu } from '@/components/ui/Menu';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  isAccessRefused,
  isRefusedRead,
  useAccessLostNotice,
} from '@/features/collaboration/accessLostNotice';
import { downloadShownEdits } from '@/features/collaboration/deletedEditsToast';
import {
  copyLabel,
  dropDeletedCopies,
  keepsCopyOf,
  type RoomCopy,
  useKeepMaterialCopy,
  useMaterialCopy,
  useRoomSeed,
} from '@/features/collaboration/deviceCopy';
import {
  type DeletedTarget,
  deletedTarget,
  reloadDeleted,
  useDeletedEdits,
  useShowsDeleted,
} from '@/features/collaboration/lostEdits';
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
  PhoneMenuItems,
  PresenceContext,
} from '@/features/files/fileModeContext';
import {
  fileIsIngesting,
  IMAGE_MIN_ZOOM,
  legacyOfficeTarget,
} from '@/features/files/fileUtils';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import { TrashBanner } from '@/features/files/TrashBanner';
import { FlashcardGrid } from '@/features/flashcards/FlashcardGrid';
import { LiveFlashcards } from '@/features/flashcards/LiveFlashcards';
import { useLiveSetCards } from '@/features/flashcards/liveReads';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import type { ExportFormat } from '@/features/notes/export/render';
import { useLiveQuizQuestions } from '@/features/quizzes/liveQuizReads';
import {
  QuizEditor,
  QuizPaneTitle,
  QuizReadSplit,
} from '@/features/quizzes/QuizEditor';
import { QuizPreviewButton } from '@/features/study/assignments/PreviewButton';
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
import { useFullscreenSearch } from '@/lib/useFullscreenSearch';
import { useMediaQuery } from '@/lib/useMediaQuery';
import {
  createEditorStatusStore,
  EditorStatusStoreContext,
  Header,
  type OneColumnChrome,
  OneColumnTitle,
} from './CenterContentHeader';
import type { MaterialDocument } from './document';
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
import { forgetAssetLinks } from './resolvedAssetLinks';
import { storedCards, storedQuestions } from './storedItems';

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
  trash,
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
  /** Opened from the Trash: read-only, joining no room, until restored. */
  trash?: Trashed;
  color?: UserColor;
  onDeleted: () => void;
  requestedMode?: MaterialMode | null;
  onModeChange: (mode: MaterialMode) => void;
  workspaceId: string;
}) {
  const [fileHeader, setFileHeader] = useState<HTMLSpanElement | null>(null);
  const [fileMenu, setFileMenu] = useState<HTMLSpanElement | null>(null);
  const [fileActions, setFileActions] = useState<HTMLSpanElement | null>(null);
  // What the open file puts in ⋮ on phones (usePhoneMenuItem).
  const [phoneItems, setPhoneItems] = useState<Record<string, MenuItem>>({});
  const setPhoneItem = useCallback(
    (key: string, menuItem: MenuItem | null) =>
      setPhoneItems((current) => {
        const { [key]: _gone, ...rest } = current;
        return menuItem ? { ...rest, [key]: menuItem } : rest;
      }),
    []
  );
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  // An Office or text file's: a material opens at the highest mode its reader
  // may have (Epo 2026-11-04).
  const fileMode =
    item?.kind === 'file' ? (requestedMode ?? readDocumentMode(item)) : 'view';
  // Full screen lives in the URL; opening another item drops it with the
  // rest of the search.
  const [isFullscreen, setFullscreen] = useFullscreenSearch();
  const [editorStatus] = useState(createEditorStatusStore);
  // Stable: the store's own setter, so reporting never re-renders this pane.
  const setEditorStatus = editorStatus.getState().report;
  // The open room's other editors, for the header's avatar group.
  const [presence] = useState(createPresenceStore);
  const setPresence = presence.getState().report;
  // An Office file's menus reached the header: its second row shows.
  const [menuShown, setMenuShown] = useState(false);
  // A deleted item whose unsent edits the body shows: its strip's and ⋮'s
  // Download (Epo 2026-11-20).
  const [shownDeleted, setShownDeleted] = useState<ShownDeleted | null>(null);
  const stripDownload = useMemo(
    () =>
      shownDeleted &&
      (() => void downloadShownEdits(shownDeleted.target, shownDeleted.item)),
    [shownDeleted]
  );
  const deletedDownloads = useMemo(
    () => deletedMenuItems(shownDeleted),
    [shownDeleted]
  );

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setEditorStatus(null);
    setPresence(null);
    setMenuShown(false);
  }, [item?.kind, item?.id]);

  useEffect(() => {
    if (item?.kind === 'file' && requestedMode)
      saveDocumentMode(item, requestedMode);
  }, [item?.kind, item?.id, requestedMode]);

  // Each open orders Recent Files (the hook sends at most one per item per
  // few minutes); one in the trash is not recent.
  const recordOpen = useRecordOpen();
  const openKind = item?.kind;
  const openId = item?.id;
  const trashed = !!trash;
  useEffect(() => {
    if (openKind && openId && !trashed)
      recordOpen({ id: openId, kind: openKind });
  }, [openKind, openId, recordOpen, trashed]);

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
                    <PhoneMenuItems.Provider value={setPhoneItem}>
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
                            deletedDownloads={deletedDownloads}
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
                            phoneItems={Object.values(phoneItems)}
                            presence={presence}
                            readOnly={readOnly}
                            standalone={standalone}
                            topics={topics}
                            trashed={trashed}
                            workspaceId={workspaceId}
                          />
                        </div>
                        {/* One strip at a time under the header: the newest shows. */}
                        <ShownDeletedContext.Provider value={setShownDeleted}>
                          <DeletedDownload.Provider value={stripDownload}>
                            <BannerStack key={item.id}>
                              {trash && (
                                <TrashBanner
                                  item={item}
                                  trash={trash}
                                  workspaceId={workspaceId}
                                />
                              )}
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
                                    trashed={trashed}
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
                                    trashed={trashed}
                                  />
                                )}
                              </div>
                            </BannerStack>
                          </DeletedDownload.Provider>
                        </ShownDeletedContext.Provider>
                      </div>
                    </PhoneMenuItems.Provider>
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

/** The kind the cached Files page list gives a standalone material, so a
 * read that fails can still name it. */
function listedKind(queryClient: QueryClient, id: string) {
  for (const [, data] of queryClient.getQueriesData<InfiniteData<ItemPage>>({
    queryKey: qk.itemsRoot,
  })) {
    for (const page of data?.pages ?? []) {
      for (const item of page.items) {
        if (item.type === 'material' && item.material.id === id)
          return item.material.kind;
      }
    }
  }
}

/** A deleted item whose unsent edits the body shows (Q39): the header's ⋮
 * and the deleted strip download what shows (Epo 2026-11-20). */
interface ShownDeleted {
  item: DeletedItem;
  target: DeletedTarget;
}

const ShownDeletedContext = createContext<
  ((shown: ShownDeleted | null) => void) | null
>(null);

/** Names the deleted item the body shows its unsent edits of, once its room,
 * session or note drawing shows them (`useShowsDeleted`): before, a Download
 * would draw nothing. */
function useShowDeleted(
  target: DeletedTarget | null,
  item: DeletedItem | undefined
) {
  const set = useContext(ShownDeletedContext);
  const drawn = useShowsDeleted(target);
  const shown = drawn && target && item ? { item, target } : null;
  const latest = useRef(shown);
  latest.current = shown;
  const key = shown
    ? [target?.id, ...(target?.keys ?? []), item?.kind, item?.name].join('\n')
    : '';
  useEffect(() => {
    if (!(set && key)) return;
    set(latest.current);
    return () => set(null);
  }, [set, key]);
}

/** The header ⋮'s downloads of a deleted item's unsent edits, made from what
 * the page shows, as its strip's Download (Epo 2026-11-20): a note's as
 * Markdown and Word, a file's in its own format. Other kinds have no download
 * in ⋮: their strip's, and a canvas's Download as image in its board menu. */
function deletedMenuItems(shown: ShownDeleted | null): MenuItem[] {
  if (!shown) return [];
  const save = (format?: ExportFormat) => () =>
    void downloadShownEdits(shown.target, shown.item, format);
  if (shown.target.file)
    return [{ icon: 'download', label: m.action_download(), onClick: save() }];
  if (shown.item.kind !== 'note') return [];
  return [
    {
      icon: 'download',
      label: m.action_download_markdown(),
      onClick: save('markdown'),
    },
    {
      icon: 'download',
      label: m.action_download_docx(),
      onClick: save('docx'),
    },
  ];
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
  allowExternalAssets,
  onEditorStatusChange,
  onPresenceChange,
  readOnly,
  target,
  trashed,
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
  trashed: boolean;
}) {
  const { data: materials, isPending } = useMaterials(workspaceId);
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<HeavyMaterialChoice | null>(null);

  // Wait for the list before deciding. Rendering first and gating afterwards
  // would download the very document the gate exists to avoid, then throw the
  // mounted editor away.
  if (workspaceId && isPending) return <MaterialLoading />;

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
      onEditorStatusChange={onEditorStatusChange}
      onPresenceChange={onPresenceChange}
      staticNote={choice === 'readOnly'}
      target={target}
      trashed={trashed}
    />
  );
}

/** Nothing to paint yet: a wordless skeleton (Epo 2026-11-04), or while offline
 * the one true thing to say (C9). */
function MaterialLoading() {
  const online = useOnlineStatus();
  return online ? <NoteSkeleton /> : <FileLoading />;
}

/** A set's View: the stored cards, then the room's as they change. */
function LiveSetGrid({
  material,
  action,
  live,
  openCardId,
}: {
  material: Material;
  action: ReactNode;
  /** Off for a set opened from the Trash: its stored cards only. */
  live: boolean;
  /** A card to open at once (a link to it). */
  openCardId?: string;
}) {
  const cards = useLiveSetCards(
    material.id,
    storedCards(material.content),
    live
  );
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
  trashed = false,
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
  /** Opened from the Trash: its stored content, joining no room or study. */
  trashed?: boolean;
}) {
  // Nothing of a trashed item's own beyond its read, as a heavy note's.
  const isStatic = staticNote || trashed;
  const {
    data: loaded,
    dataUpdatedAt,
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
  // When this person last lost editing here (`readOnly` 'access').
  const loweredAt = useRef(0);
  const lower = useCallback(() => {
    loweredAt.current = Date.now();
    setReadOnly('access');
  }, []);
  const queryClient = useQueryClient();
  const onReadOnly = useCallback(
    (code?: ReadOnlyCode) => {
      // Read-only views draw the read, so it follows. A room's refusal asks for
      // none: only a refused read ends what shows.
      if (code !== 'access_lost')
        void queryClient.invalidateQueries({
          queryKey: qk.material(materialId),
        });
      if (code) setReadOnly(code);
      else lower();
    },
    [lower, materialId, queryClient]
  );
  // When the item's read last answered a fetch: a cache write (a mutation's
  // rollback) is no answer.
  const readAnswered = () =>
    answeredAt(
      queryClient
        .getQueryCache()
        .get<unknown, unknown>(hashKey(qk.material(materialId)))
    );
  // Its read answered fresh as the page opened (a preload, the route's
  // loader), not kept from an earlier visit.
  const [openedAt] = useState(Date.now);
  const [openedLive] = useState(() =>
    freshAnswer(
      queryClient
        .getQueryCache()
        .get<unknown, unknown>(hashKey(qk.material(materialId)))
    )
  );
  const overBar = useContext(FloatingBarContext);
  // The static renderer ahead of the paint, for a note or what may turn out to
  // be one: no other kind draws it.
  useEffect(() => {
    if (!kind || kind === 'note') void loadPreview();
  }, [kind]);
  const { data: me } = useMe({ errorBoundary: false });
  // A heavy note opened read-only reads nothing of its own beyond its read.
  const seed = useRoomSeed(materialId, isStatic ? null : me?.id);
  // A note's room token beside its read, not a round trip behind it. Its editor
  // and a viewer's read channel (liveNoteRead) both start from this request. A
  // refusal stays quiet here: the read says what shows.
  const opensNote = !isStatic && (kind === 'note' || seed?.row.kind === 'note');
  const noteOpen = useRef(false);
  useEffect(() => {
    if (!opensNote) return;
    const token = materialTokenQuery(materialId);
    noteOpen.current = true;
    void queryClient.prefetchQuery(token);
    // A read token nothing took goes with the note: an editor mounted later, this
    // person raised meanwhile, would start from it.
    return () => {
      noteOpen.current = false;
      const drop = () => {
        if (
          !noteOpen.current &&
          queryClient.getQueryData(token.queryKey)?.access === 'read'
        )
          queryClient.removeQueries({ queryKey: token.queryKey });
      };
      drop();
      queryClient
        .getQueryCache()
        .find({ queryKey: token.queryKey })
        ?.promise?.then(drop, () => undefined);
    };
  }, [materialId, opensNote, queryClient]);
  // An item's last read, painting until this one answers.
  const copied = useMaterialCopy(materialId, isStatic ? null : me?.id);
  const refused = isRefusedRead(error);
  // Deleted (Q39): its read answers `item_deleted`, or to its trash readers
  // (its payer, the workspace's owner) the trashed item, here on a page not
  // opened from the Trash.
  const deleted = !!deletedItemOf(error) || (!trashed && !!loaded?.trash);
  // No access, or gone: what this device kept of it goes too, but a deleted
  // item's while this device holds edits to it (`dropDeletedCopies`).
  const lost =
    deleted ||
    (isApiError(error) && (error.status === 403 || error.status === 404));
  const owner = me?.id;
  useEffect(() => {
    if (!lost) return;
    if (deleted) void dropDeletedCopies(owner, materialId);
    else void dropDeviceCopies(materialId);
    // Signed links outlast access by their lifetime, but no further (Epo Q678 A).
    forgetAssetLinks();
  }, [lost, deleted, owner, materialId]);
  // Deleted while this page showed it, live or from its device copy: that
  // stays, read-only, while this device holds unsent edits to it (`kept`),
  // shown to copy until Reload (a note's drawn from them, as its Download
  // draws them); with none it is unavailable as any refusal.
  const shownLive = useRef<Material | undefined>(undefined);
  const showing = loaded ?? copied;
  if (!deleted && showing) shownLive.current = showing;
  const shown = shownLive.current;
  const deletedDocs = deletedTarget(
    me?.id,
    false,
    materialId,
    shown?.kind === 'quiz'
  );
  const deletedEdits = useDeletedEdits(
    deletedDocs,
    deleted && !!shown,
    shown?.kind === 'note'
  );
  const keptDeleted =
    deleted && deletedEdits?.status !== 'none' ? shown : undefined;
  // A deleted note's kept edits drawn from the stored rows alone, as its
  // Download draws them: what its strip says shows, and its Reload deletes.
  const deletedNote = deletedEdits?.status === 'kept' && deletedEdits.note;
  const drawnNote = useMemo(
    () =>
      keptDeleted && deletedNote
        ? {
            ...keptDeleted,
            content: { ...keptDeleted.content, value: deletedNote },
            contentOmitted: false,
          }
        : undefined,
    [keptDeleted, deletedNote]
  );
  // Its editor went: the header's save status with it.
  useEffect(() => {
    if (drawnNote) onEditorStatusChange(null);
  }, [drawnNote, onEditorStatusChange]);
  // A refusal ends what shows; a read that could not answer leaves it, an open
  // editor included.
  const material =
    keptDeleted ??
    (refused || deleted ? undefined : (loaded ?? copied ?? undefined));
  useKeepMaterialCopy(
    loaded?.kind === 'note' ? undefined : loaded,
    isStatic ? null : me?.id,
    copied
  );
  useShowDeleted(
    deletedEdits?.status === 'kept' ? deletedDocs : null,
    keptDeleted && { kind: keptDeleted.kind, name: keptDeleted.title }
  );
  // Kicked: it worked here, then its read refused the person access. Not for
  // one opened from the Trash or deleted (a trashed read kept), whose purge is
  // a deletion.
  useAccessLostNotice(false, materialId, {
    read: qk.material(materialId),
    refused: isAccessRefused(error) && !(trashed || deleted),
    workspaceId: shown?.workspaceId,
  });
  // Lowered after a live answer said this person may edit: the workspace's
  // read or the item's own says they may not now (a demotion's notice reads
  // them before the item's rooms close, 4403, and rejoin on a read token).
  // The editor goes before its rooms could say so, and it reads on under the
  // strip, as that token makes it. A full payer's storage takes no right
  // (its own strip, `storageFull`), and someone lowered while away opens with
  // no cue (D1). A refused read shows its own page instead.
  //
  // A live answer: the item's read answered on this page, or as it opened, not
  // its device copy nor a read kept from an earlier visit, which may hold last
  // visit's rights; nor a deleted item's (a trashed read has every right off).
  const live =
    loaded && !deleted && (openedLive || readAnswered() > openedAt)
      ? loaded.capabilities
      : undefined;
  const mayEdit = live && !forceReadOnly && live.canEdit;
  const editorShown = useRef(false);
  useEffect(() => {
    if (mayEdit === undefined || readOnly) return;
    if (mayEdit) editorShown.current = true;
    else if (editorShown.current) {
      editorShown.current = false;
      lower();
    }
  }, [lower, mayEdit, readOnly]);
  // A quiz or set lowered here edits again once a read after it says this
  // person may (Q642 C: its rooms turn editable at their next token, its
  // editor opening anew); a note or a diagram stays read-only until a reload,
  // and every kind keeps a code's strip (lost access, an unsupported block).
  const raisable = loaded?.kind === 'quiz' || loaded?.kind === 'flashcards';
  useEffect(() => {
    if (
      readOnly === 'access' &&
      raisable &&
      !forceReadOnly &&
      live?.canEditContent &&
      readAnswered() > loweredAt.current
    )
      setReadOnly(null);
    // A new read runs this again (`dataUpdatedAt`).
  }, [dataUpdatedAt, forceReadOnly, live, raisable, readOnly]);
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
      seed={isStatic ? null : seed}
      staticNote={isStatic}
    />
  );
  // A device copy paints before its read answers, and while the read cannot
  // answer (the browser offline, the server down), until it refuses.
  // Keyed as the note below: the paint keeps its DOM as the read answers.
  if (!material && seed?.row.kind === 'note' && !(refused || deleted))
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
    ) : refused || deleted ? (
      <UnavailableItem />
    ) : (
      <FileError
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  // The highest mode this reader may have; a deleted item's kept edits show
  // in its editor, which its room or the drawn note keeps read-only.
  const activeMode =
    !(forceReadOnly || (readOnly && !keptDeleted)) &&
    material.capabilities.canEditContent
      ? 'edit'
      : 'view';
  // Refused by its room, an editor stays mounted and read-only, showing what it
  // holds rather than the older read (Epo 2026-11-05), and so does a deleted
  // item's with unsent edits (Q39).
  const editorMounted =
    activeMode === 'edit' || readOnly === 'access_lost' || !!keptDeleted;
  const roomCopy: RoomCopy = {
    keep: me && keepsCopyOf(material) ? copyLabel(material, me.id) : undefined,
    seed,
  };
  // Its payer (whoever created it) at the storage limit opens it view-only
  // under a strip saying so (uploader pays). A deleted note's edits show under
  // the deleted strip; an item room's editor draws its own (`recovery`).
  const readOnlyStrip = keptDeleted ? (
    drawnNote &&
    deletedDocs && (
      <SaveBanner onReload={() => reloadDeleted(deletedDocs)} state="deleted" />
    )
  ) : material.storageFull ? (
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
  if (drawnNote)
    return (
      <div className="flex h-full min-h-0 flex-col">
        {readOnlyStrip}
        <div className="min-h-0 flex-1" key="deleted-note">
          <NoteBody
            allowExternalAssets={false}
            editing={false}
            material={drawnNote}
            materialId={materialId}
            onEditorStatusChange={onEditorStatusChange}
            onReadOnly={onReadOnly}
            owner={me?.id}
            seed={null}
            staticNote
          />
        </div>
      </div>
    );
  // A deleted item's Preview and Practice need the server it is gone from.
  if (material.kind === 'quiz' && activeMode === 'edit') {
    return (
      <QuizEditor
        // Preview: the quiz as members get it (Epo 2026-11-15).
        action={!keptDeleted && <QuizPreviewButton quizId={materialId} />}
        copy={roomCopy}
        key={materialId}
        onPresenceChange={onPresenceChange}
        onReadOnly={onReadOnly}
        onStatusChange={onEditorStatusChange}
        practice={
          !keptDeleted && <PracticeButton kind="quiz" materialId={materialId} />
        }
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
        topicId={material.topicId}
        workspaceId={material.workspaceId}
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
                  !keptDeleted && (
                    <PracticeButton kind="flashcards" materialId={materialId} />
                  )
                }
                copy={roomCopy}
                onPresenceChange={onPresenceChange}
                onReadOnly={onReadOnly}
                onStatusChange={onEditorStatusChange}
                openCardId={target}
                setId={materialId}
                stored={storedCards(material.content)}
                title={material.title}
              />
            ) : (
              <LiveSetGrid
                action={
                  !trashed && (
                    <PracticeButton kind="flashcards" materialId={materialId} />
                  )
                }
                live={!trashed}
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
                live={!trashed}
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
  live,
  provenance,
  quizId,
  target,
  title,
}: {
  content: MaterialDocument;
  /** Off for a quiz opened from the Trash: its stored questions only, and
   * no Study. */
  live: boolean;
  provenance: Provenance | undefined;
  quizId: string;
  /** A question to scroll to, e.g. from a review summary. */
  target?: string;
  title: string;
}) {
  const overBar = useContext(FloatingBarContext);
  // Someone gone from editing to viewing keeps no answers on this device.
  useEffect(() => {
    void dropDeviceCopies(quizId, 'keys');
  }, [quizId]);
  // The stored questions paint first; the live room follows (live-items).
  const questions = useLiveQuizQuestions(
    quizId,
    storedQuestions(content),
    live
  );
  return (
    <>
      {/* The header names it for the eye; the page's one h1 stays its title. */}
      {!live && <h1 className="sr-only">{title}</h1>}
      <QuizReadSplit
        head={
          live && (
            <QuizPaneTitle
              action={<PracticeButton kind="quiz" materialId={quizId} />}
              title={title}
            />
          )
        }
        paneClassName={cn(overBar && 'pb-20')}
        questions={questions}
        sources={
          <SourcesLine
            className={cn('pb-4', overBar && 'pb-20')}
            provenance={provenance}
          />
        }
        target={target}
      />
    </>
  );
}

/** Practice: a quiz's attempt or a set's study session, in View and Edit. */
function PracticeButton({
  kind,
  materialId,
}: {
  kind: 'quiz' | 'flashcards';
  materialId: string;
}) {
  const navigate = useNavigate();
  return (
    <PageButton
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
      variant="dark"
    >
      {m.action_practice()}
    </PageButton>
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
          // A tall page under it must not squeeze it (the Files view did).
          'flex h-12 shrink-0 items-center gap-1 border-divider border-b sm:h-15',
          // Workspace buttons at the edges sit as far in as a file header's.
          leading ? 'px-3' : 'px-2 sm:px-4',
          // As in a file header: the title pill's padding spaces it.
          !(leading && oneColumn) && 'sm:gap-2'
        )}
        data-center-header=""
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
            <OneColumnTitle>
              {/* Sized as an open file's icon in the same spot. */}
              <img
                alt=""
                className="size-4.5 shrink-0 rounded-[4px] md:size-5"
                src={iconUrl(oneColumn.workspaceIconId)}
              />
              <span className="min-w-0 truncate">
                {oneColumn.workspaceName}
              </span>
            </OneColumnTitle>
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

/** An open file's body: its viewer, or what its read says instead. */
export function FileBody({
  fileId,
  color,
  imageZoom,
  onImageZoomChange,
  page,
  regions,
  citation,
  trashed,
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  page?: number;
  regions?: Region[];
  citation?: OfficeCitation;
  /** Opened from the Trash: its trashed read is what shows. */
  trashed: boolean;
}) {
  const {
    data: read,
    error,
    isLoading,
    isError,
    refetch,
  } = useFile(fileId, {
    errorBoundary: false,
  });
  const { data: me } = useMe({ errorBoundary: false });
  // Deleted while this page showed it (Q39), its read answering
  // `item_deleted` or, to its trash readers, trashed: as a material's, its
  // last live read stays while this device holds unsent edits to it, the
  // editor under its deleted strip (useSourceSession).
  const deleted = !!deletedItemOf(error) || (!trashed && !!read?.trash);
  const shownLive = useRef<SourceFile | undefined>(undefined);
  if (read && !deleted) shownLive.current = read;
  const deletedDocs = deletedTarget(me?.id, true, fileId);
  const deletedEdits = useDeletedEdits(
    deletedDocs,
    deleted && !!shownLive.current
  );
  const kept =
    deleted && deletedEdits?.status !== 'none' ? shownLive.current : undefined;
  const file = kept ?? (deleted ? undefined : read);
  const refused = isRefusedRead(error);
  useShowDeleted(
    deletedEdits?.status === 'kept' ? deletedDocs : null,
    kept && { kind: kept.kind, name: kept.name }
  );
  useAccessLostNotice(true, fileId, {
    read: qk.file(fileId),
    refused: isAccessRefused(error) && !(trashed || deleted),
    workspaceId: shownLive.current?.workspaceId,
  });
  if (isLoading) return <FileLoading />;
  // A refusal ends what shows, as a material's does (Epo 2026-11-05).
  if ((refused || deleted) && !kept) return <UnavailableItem />;
  if (!file && isError)
    return (
      <FileError
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
      />
    );
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
      {/* An old Office file being converted says so in its pane instead.
       * One opened from the Trash shows the trash strip alone. */}
      {file &&
        !file.trash &&
        fileIsIngesting(file.status) &&
        file.hasBytes &&
        !legacyOfficeTarget(file.name) && (
          <FileBanner
            message={
              file.status === 'pending'
                ? m.files_pending_named({ name: file.name })
                : m.files_processing_named({ name: file.name })
            }
          />
        )}
      {file && !file.trash && <FileNotIndexedBanner file={file} />}
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
