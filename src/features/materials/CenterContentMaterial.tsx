import { useNavigate } from '@tanstack/react-router';
import {
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
import { isMaterialContentUnreadable } from '@/api/client';
import { useMaterial, useMaterials } from '@/api/hooks';
import type { Material, Provenance } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { TabContent } from '@/components/app/tabPanel';
import { FileBanner } from '@/components/banners/FileBanner';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { FlashcardGrid } from '@/features/flashcards/FlashcardGrid';
import { LiveFlashcards } from '@/features/flashcards/LiveFlashcards';
import { useLiveSetCards } from '@/features/flashcards/liveReads';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import type { LearnerQuestion } from '@/features/questions/types';
import { useLiveQuizQuestions } from '@/features/quizzes/liveQuizReads';
import { QuizEditor } from '@/features/quizzes/QuizEditor';
import { QuizQuestionList } from '@/features/quizzes/QuizPage';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
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
import { MermaidMaterialView } from './MermaidMaterialView';
import {
  type MaterialMode,
  materialModePolicy,
  resolveMaterialMode,
} from './modePolicy';
import { embedKey, useNoteFooter } from './useNoteFooter';

/* The center pane's study material body (CenterContent), loaded with the
 * first material it opens: a file never loads the quiz, card set and diagram
 * views. */

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
type PreviewComponent =
  | typeof LazyMaterialPreview
  | typeof import('./MaterialPreview').MaterialPreview;

/** Gates the fetch on a confirmation when the list metadata says the document
 * is heavy. The weight comes from the already-cached material list, so nothing
 * of the document itself is downloaded before the reader chooses. Keyed by
 * material id at the call site: resetting the choice in an effect would let the
 * next document start fetching for the render before the reset lands. */
export function MaterialBody({
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
      staticNote={choice === 'readOnly'}
      target={target}
    />
  );
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

export function MaterialContent({
  centerQuiz,
  materialId,
  mode,
  allowExternalAssets,
  forceReadOnly,
  onEditorStatusChange,
  staticNote = false,
  target,
}: {
  centerQuiz: boolean;
  materialId: string;
  mode: MaterialMode | null;
  allowExternalAssets: boolean;
  forceReadOnly: boolean;
  onEditorStatusChange: (status: NoteEditorStatus | null) => void;
  /** A heavy note opened read-only: View paints the projection and never
   * joins the room, as the gate promises (REVIEW5 S3). */
  staticNote?: boolean;
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
        title={m.material_decode_title()}
      />
    ) : (
      <FileError />
    );
  }
  const policy = materialModePolicy(material.capabilities);
  const activeMode =
    forceReadOnly || readOnly ? 'view' : resolveMaterialMode(mode, policy);
  const readOnlyStrip = readOnly && (
    <FileBanner
      message={
        readOnly === 'unsupported_block'
          ? m.editor_unsupported_block_strip()
          : m.editor_read_only_strip()
      }
    />
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
        <TabContent centered={centerQuiz}>
          <QuizEditor
            action={<StudyLink kind="quiz" materialId={materialId} />}
            key={materialId}
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
                action={<StudyLink kind="flashcards" materialId={materialId} />}
                onStatusChange={onEditorStatusChange}
                setId={materialId}
                title={material.title}
              />
            ) : (
              <LiveSetGrid
                action={<StudyLink kind="flashcards" materialId={materialId} />}
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
  useEffect(() => {
    setLive(null);
    let leave: (() => void) | undefined;
    let gone = false;
    const timer = setTimeout(() => {
      void import('@/features/notes/liveNoteRead').then(({ readNoteLive }) => {
        if (!gone) leave = readNoteLive(material.id, first.current, setLive);
      });
    });
    return () => {
      gone = true;
      clearTimeout(timer);
      leave?.();
    };
  }, [material.id]);
  return (
    <Preview
      content={material.content}
      isStandalone={!material.workspaceId}
      kind={material.kind}
      title={material.title}
      value={live ?? painted}
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
    <TabContent centered={centered}>
      <div className="mb-7 flex items-baseline gap-4">
        <h1 className="t-large-card-title min-w-0 flex-1">{title}</h1>
        <StudyLink kind="quiz" materialId={quizId} />
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
function StudyLink({
  kind,
  materialId,
}: {
  kind: 'quiz' | 'flashcards';
  materialId: string;
}) {
  const navigate = useNavigate();
  return (
    <TitleAction
      label={m.action_study()}
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
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm font-semibold text-sm text-tint-accent-1-fg underline underline-offset-4 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-action"
      onClick={onClick}
      type="button"
    >
      {label}
      <Icon className="size-4 -translate-y-px" name="arrowRight" />
    </button>
  );
}
