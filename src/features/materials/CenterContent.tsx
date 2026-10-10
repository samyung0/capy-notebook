import { Navigate, useNavigate, useRouter } from '@tanstack/react-router';
import {
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { isMaterialContentUnreadable } from '@/api/client';
import { useFile, useMaterial, useMaterials } from '@/api/hooks';
import type {
  Chapter,
  MaterialKind,
  Provenance,
  Region,
  UserColor,
} from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { TabContent } from '@/components/app/tabPanel';
import { BannerStack, FileBanner } from '@/components/banners/FileBanner';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import {
  FileError,
  FileLoading,
  FileNotIndexedBanner,
} from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import {
  EditorStatusContext,
  FileActionsTarget,
  FileHeaderTarget,
  FileMenuTarget,
  FileModeContext,
} from '@/features/files/fileModeContext';
import { fileIsIngesting, IMAGE_MIN_ZOOM } from '@/features/files/fileUtils';
import type { OfficeCitation } from '@/features/files/officeProtocol';
import { FlashcardGrid } from '@/features/flashcards/FlashcardGrid';
import { FlashcardsEditor } from '@/features/flashcards/FlashcardsEditor';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { handOverLiveNote } from '@/features/notes/liveNoteHandover';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import type { LearnerQuestion } from '@/features/questions/types';
import { QuizQuestionList } from '@/features/quizzes/QuizPage';
import { quizEditSearch } from '@/features/quizzes/quizNavigation';
import {
  OfflineStatus,
  WorkspaceStatusButton,
} from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { createEditorStatusStore, Header } from './CenterContentHeader';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
  type MaterialDocument,
  type QuizElement,
} from './document';
import { HeavyMaterialGate } from './HeavyMaterialGate';
import { type HeavyMaterialChoice, heavyMaterial } from './heavyDocument';
import {
  MaterialAttributionFooter,
  SourcesLine,
} from './MaterialAttributionFooter';
import { MermaidMaterialView } from './MermaidMaterialView';
import {
  type MaterialMode,
  materialModePolicy,
  resolveMaterialMode,
} from './modePolicy';
import { type OpenItem, readDocumentMode, saveDocumentMode } from './openItem';

/* Interactive Plate is the heaviest chunk in this route. View mode
 * deliberately never loads it. */
const NoteEditor = lazy(() =>
  import('@/features/notes/NoteEditor').then((m) => ({
    default: m.NoteEditor,
  }))
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
type PreviewComponent =
  | typeof LazyMaterialPreview
  | typeof import('./MaterialPreview').MaterialPreview;

/** The center pane. Dispatches on the currently-open item — a source file or a
 * study material — and renders a consistent header plus the item body. Quiz and
 * flashcards materials get view actions in the header; mindmaps/diagrams render inline.
 * User-authored notes take over the whole pane with the editable Plate editor. */
export function CenterContent({
  beforeFileDelete,
  chapters,
  item,
  readOnly = false,
  color,
  onDeleted,
  onFileViewerDirtyChange,
  onModeChange,
  requestedMode = null,
  workspaceId,
  leading,
  standalone = false,
}: {
  standalone?: boolean;
  beforeFileDelete?: () => boolean;
  /** Workspace chrome drawn before the file name in the header. */
  leading?: ReactNode;
  chapters: Chapter[];
  item: OpenItem | null;
  readOnly?: boolean;
  color?: UserColor;
  onDeleted: () => void;
  onFileViewerDirtyChange?: (dirty: boolean) => void;
  requestedMode?: MaterialMode | null;
  onModeChange: (mode: MaterialMode) => void;
  workspaceId: string;
}) {
  const [fileHeader, setFileHeader] = useState<HTMLSpanElement | null>(null);
  const [fileMenu, setFileMenu] = useState<HTMLSpanElement | null>(null);
  const [fileActions, setFileActions] = useState<HTMLSpanElement | null>(null);
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  const materialMode =
    requestedMode ?? (item ? readDocumentMode(item) : 'view');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editorStatus] = useState(createEditorStatusStore);
  // Stable: the store's own setter, so reporting never re-renders this pane.
  const setEditorStatus = editorStatus.getState().report;

  useEffect(() => {
    setImageZoom(IMAGE_MIN_ZOOM);
    setEditorStatus(null);
    setIsFullscreen(false);
  }, [item?.kind, item?.id]);

  useEffect(() => {
    if (item && requestedMode) saveDocumentMode(item, requestedMode);
  }, [item?.kind, item?.id, requestedMode]);

  const changeMaterialMode = (nextMode: MaterialMode) => {
    setEditorStatus(null);
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
              <div
                className={cn(
                  'flex min-h-0 flex-1 flex-col bg-surface',
                  isFullscreen && 'fixed inset-0 z-40'
                )}
              >
                <Header
                  beforeFileDelete={beforeFileDelete}
                  chapters={chapters}
                  color={color}
                  editorStatus={editorStatus}
                  fileActions={
                    <span className="flex items-center" ref={setFileActions} />
                  }
                  fileControls={
                    <span className="flex items-center" ref={setFileHeader} />
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
                  onDeleted={onDeleted}
                  onImageZoomChange={setImageZoom}
                  onMaterialModeChange={changeMaterialMode}
                  onToggleFullscreen={() => setIsFullscreen((value) => !value)}
                  readOnly={readOnly}
                  standalone={standalone}
                  workspaceId={workspaceId}
                />
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
                        key={item.id}
                        materialId={item.id}
                        mode={materialMode}
                        onEditorStatusChange={setEditorStatus}
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
                        onViewerDirtyChange={onFileViewerDirtyChange}
                        page={item.page}
                        regions={item.regions}
                      />
                    )}
                  </div>
                </BannerStack>
              </div>
            </EditorStatusContext.Provider>
          </FileActionsTarget.Provider>
        </FileMenuTarget.Provider>
      </FileHeaderTarget.Provider>
    </FileModeContext.Provider>
  );
}

/** Gates the fetch on a confirmation when the list metadata says the document
 * is heavy. The weight comes from the already-cached material list, so nothing
 * of the document itself is downloaded before the reader chooses. Keyed by
 * material id at the call site: resetting the choice in an effect would let the
 * next document start fetching for the render before the reset lands. */
function MaterialBody({
  centerQuiz,
  materialId,
  workspaceId,
  mode,
  allowExternalAssets,
  onEditorStatusChange,
  readOnly,
  target,
}: {
  centerQuiz: boolean;
  materialId: string;
  workspaceId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  readOnly: boolean;
  target?: string;
}) {
  const { data: materials, isPending } = useMaterials(workspaceId);
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
      forceReadOnly={readOnly || choice === 'readOnly'}
      key={materialId}
      materialId={materialId}
      mode={mode}
      onEditorStatusChange={onEditorStatusChange}
      target={target}
    />
  );
}

export function MaterialContent({
  centerQuiz,
  materialId,
  mode,
  allowExternalAssets,
  forceReadOnly,
  onEditorStatusChange,
  target,
}: {
  centerQuiz: boolean;
  materialId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  forceReadOnly: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  /** A question or card to bring into view once the material shows. */
  target?: string;
}) {
  const {
    data: material,
    error,
    isLoading,
  } = useMaterial(materialId, {
    errorBoundary: false,
  });
  // The open room turned read-only (a frozen account or an owner at its storage
  // limit): view mode under a grey strip; unsaved edits are discarded.
  const [readOnly, setReadOnly] = useState(false);
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
        title={m.material_decode_title()}
      />
    ) : (
      <FileError />
    );
  }
  const policy = materialModePolicy(material.capabilities);
  const activeMode =
    forceReadOnly || readOnly ? 'view' : resolveMaterialMode(mode, policy);
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
    return <OpenQuizEditor quizId={materialId} />;
  }
  if (material.kind === 'flashcards') {
    const cards = flashcardsElementToCards(
      material.content.value.find(
        (node): node is FlashcardsElement => node.type === 'flashcards'
      ) ?? { children: [], id: '', type: 'flashcards' }
    );
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <TabContent centered={centerQuiz}>
            {activeMode === 'edit' ? (
              <FlashcardsEditor
                cards={cards}
                revision={material.revision}
                setId={materialId}
                title={material.title}
              />
            ) : (
              <FlashcardGrid
                action={<StudySetLink setId={materialId} />}
                cards={cards}
                openCardId={target}
                title={material.title}
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
    activeMode === 'view'
  )
    return (
      <div className="flex h-full min-h-0 flex-col">
        {readOnly && <FileBanner message={m.editor_read_only_strip()} />}
        <div className="min-h-0 flex-1 overflow-auto">
          <MermaidMaterialView
            content={material.content}
            material={{
              isStandalone: !material.workspaceId,
              kind: material.kind,
              title: material.title,
            }}
          />
          <DocumentAttribution
            kind={material.kind}
            provenance={material.provenance}
          />
        </div>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {readOnly && <FileBanner message={m.editor_read_only_strip()} />}
      <div className="min-h-0 flex-1">
        {activeMode === 'view' && (
          <div className="h-full min-h-0 overflow-auto">
            {material.kind === 'quiz' ? (
              <QuizPreview
                centered={centerQuiz}
                content={material.content}
                provenance={material.provenance}
                quizId={materialId}
                target={target}
                title={material.title}
              />
            ) : (
              <Suspense fallback={<FileLoading />}>
                <MaterialPreview
                  content={material.content}
                  isStandalone={!material.workspaceId}
                  kind={material.kind}
                  title={material.title}
                />
                <DocumentAttribution
                  kind={material.kind}
                  provenance={material.provenance}
                />
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
                onReadOnly={() => setReadOnly(true)}
              />
            </Suspense>
          </AppErrorBoundary>
        )}
      </div>
    </div>
  );
}

/** A material's credits after its document, in the reading column the static
 * renderer uses for it, so View and Edit (NoteEditorCore) end alike. Like
 * every footer ending a view here, it keeps room under the workspace's
 * floating bar where that shows, and some space above the page's end. */
function DocumentAttribution({
  kind,
  provenance,
}: {
  kind: MaterialKind;
  provenance: Provenance | undefined;
}) {
  const displayWidth = useNoteEditorPrefs((state) => state.displayWidth);
  const overBar = useContext(FloatingBarContext);
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

/** A quiz reads exactly like the quiz page, without taking answers. Its
 * questions come from the material already loaded, so this works offline.
 * Material reads carry learner questions with no answer key; only the quiz
 * editor loads the key. */
function QuizPreview({
  centered,
  content,
  provenance,
  quizId,
  target,
  title,
}: {
  centered: boolean;
  content: MaterialDocument;
  provenance: Provenance | undefined;
  quizId: string;
  /** A question to scroll to, e.g. from a review summary. */
  target?: string;
  title: string;
}) {
  const navigate = useNavigate();
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
  const questions = (quiz?.children ?? []).flatMap((node) =>
    'type' in node && node.type === 'quiz_question'
      ? [node.question as unknown as LearnerQuestion]
      : []
  );
  return (
    <TabContent centered={centered}>
      <div className="mb-7 flex items-baseline gap-4">
        <h1 className="t-large-card-title min-w-0 flex-1">{title}</h1>
        <TitleAction
          label={m.quiz_start()}
          onClick={() =>
            navigate({ params: { quizId }, to: '/quizzes/$quizId/attempt' })
          }
        />
      </div>
      <QuizQuestionList disabled questions={questions} />
      <SourcesLine
        className={cn('mt-16 pb-4', overBar && 'pb-20')}
        provenance={provenance}
      />
    </TabContent>
  );
}

function StudySetLink({ setId }: { setId: string }) {
  const navigate = useNavigate();
  return (
    <TitleAction
      label={m.flashcards_study()}
      onClick={() =>
        navigate({
          params: { flashcardSetId: setId },
          to: '/flashcards/$flashcardSetId',
        })
      }
    />
  );
}

/** The material's one study action, set on the title's baseline at the far
 * right of the reading column. */
function TitleAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm font-semibold text-sm text-tint-accent-1-fg underline underline-offset-4 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-focus"
      onClick={onClick}
      type="button"
    >
      {label}
      <Icon className="size-4 -translate-y-px" name="arrowRight" />
    </button>
  );
}

function OpenQuizEditor({ quizId }: { quizId: string }) {
  const router = useRouter();
  return (
    <Navigate
      params={{ quizId }}
      replace
      search={quizEditSearch(router.state.location.href, true)}
      to="/quizzes/$quizId/edit"
    />
  );
}

/** No file open: the header row keeps the workspace picker, then the offline
 * and workspace status icons. No strip renders, since strips belong to a file. */
function EmptyCenter({
  leading,
  workspaceId,
}: {
  leading?: ReactNode;
  workspaceId: string;
}) {
  return (
    <>
      <div className="flex h-12 items-center gap-1 border-divider border-b pr-1 pl-2 sm:h-14 sm:gap-2 sm:px-4">
        {leading ?? (
          <>
            <Icon className="size-5.5" name="files" />
            <h2 className="t-subtitle translate-y-px truncate">--</h2>
          </>
        )}
        <OfflineStatus />
        <WorkspaceStatusButton workspaceId={workspaceId} />
      </div>
      <div className="grid flex-1 place-items-center p-6">
        <div className="flex flex-col items-center gap-3">
          <Icon className="non-scaling-svg size-8" name="files" />
          <p>{m.material_select()}</p>
        </div>
      </div>
    </>
  );
}

function FileBody({
  fileId,
  color,
  imageZoom,
  onImageZoomChange,
  onViewerDirtyChange,
  page,
  regions,
  citation,
}: {
  fileId: string;
  color?: UserColor;
  imageZoom: number;
  onImageZoomChange: (next: number) => void;
  onViewerDirtyChange?: (dirty: boolean) => void;
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
          onDirtyChange={onViewerDirtyChange}
          onImageZoomChange={onImageZoomChange}
          page={page}
          regions={regions}
        />
      </div>
    </div>
  );
}
