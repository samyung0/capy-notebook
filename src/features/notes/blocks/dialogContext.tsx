import { useNavigate, useRouter } from '@tanstack/react-router';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useCreateEmbeddedMaterial } from '@/api/hooks';
import type { Material } from '@/api/types';
import {
  parseFlashcardsFenceBody,
  parseQuizFenceBody,
} from '@/features/materials/blocks';
import {
  type MaterialRefKind,
  materialRefNode,
} from '@/features/materials/document';
import { quizEditSearch } from '@/features/quizzes/quizNavigation';
import { insertEditorNode, type NoteEditorInstance } from '../insertEditorNode';
import { YouTubeDialog } from '../YouTubeDialog';
import { FlashcardsDialog } from './FlashcardsDialog';
import type { NoteVisualBlock } from './VisualBlockDialog';

const VisualBlockDialog = lazy(() => import('./VisualBlockDialog'));

type SaveFn = (code: string) => void | Promise<void>;
type SaveYouTubeFn = (videoId: string) => void;

export interface NoteBlockDialogsApi {
  /** Create the embedded quiz or flashcard set a fence body describes. */
  createEmbedded: (kind: MaterialRefKind, code: string) => Promise<Material>;
  /** Create the row first, then insert its reference block at the caret. */
  insertEmbedded: (
    editor: NoteEditorInstance,
    kind: MaterialRefKind,
    code: string
  ) => Promise<void>;
  /** The note this editor is bound to; embedded materials are created under it. */
  noteId: string;
  openFlashcards: (initialCode: string | undefined, onSave: SaveFn) => void;
  openVisual: (
    block: NoteVisualBlock,
    onSave: (block: NoteVisualBlock) => void | Promise<void>
  ) => void;
  openYouTube: (initialUrl: string | undefined, onSave: SaveYouTubeFn) => void;
}

/** Turn a fence body into the create request for its kind. */
export function embeddedDraftFromFence(kind: MaterialRefKind, code: string) {
  if (kind === 'quiz') {
    const block = parseQuizFenceBody(code);
    return {
      kind,
      questions: block.questions,
    };
  }
  return {
    cards: parseFlashcardsFenceBody(code).cards.map((card) => ({
      back: card.back,
      front: card.front,
    })),
    kind,
  };
}

const Ctx = createContext<NoteBlockDialogsApi | null>(null);

/**
 * Module-level handle for the mounted provider. Plate inline nodes (slash input)
 * sit under PlateContent and can miss React context after HMR or when rendered
 * through Plate's element pipeline; the editor store still works, so callers
 * fall back here while a NoteEditor is mounted.
 */
let mountedDialogsApi: NoteBlockDialogsApi | null = null;

/** Hosts the quiz/flashcards authoring popups and exposes imperative openers.
 * Used both for inserting new blocks (toolbar/slash) and editing existing ones
 * (block element "Edit" button). */
export function NoteBlockDialogsProvider({
  children,
  noteId,
}: {
  children: React.ReactNode;
  noteId: string;
}) {
  const { mutateAsync: createEmbeddedMaterial } = useCreateEmbeddedMaterial();
  const navigate = useNavigate();
  const router = useRouter();
  const [flash, setFlash] = useState<{ code?: string } | null>(null);
  const [visual, setVisual] = useState<{
    block: NoteVisualBlock;
    onSave: (block: NoteVisualBlock) => void | Promise<void>;
  } | null>(null);
  const [youtube, setYouTube] = useState<{ url?: string } | null>(null);
  const saveRef = useRef<SaveFn>(() => {});
  const youtubeSaveRef = useRef<SaveYouTubeFn>(() => {});

  const openFlashcards = useCallback(
    (initialCode: string | undefined, onSave: SaveFn) => {
      saveRef.current = onSave;
      setFlash({ code: initialCode });
    },
    []
  );
  const openYouTube = useCallback(
    (initialUrl: string | undefined, onSave: SaveYouTubeFn) => {
      youtubeSaveRef.current = onSave;
      setYouTube({ url: initialUrl });
    },
    []
  );
  const openVisual = useCallback(
    (
      block: NoteVisualBlock,
      onSave: (block: NoteVisualBlock) => void | Promise<void>
    ) => setVisual({ block, onSave }),
    []
  );

  const createEmbedded = useCallback(
    (kind: MaterialRefKind, code: string) =>
      createEmbeddedMaterial({ noteId, ...embeddedDraftFromFence(kind, code) }),
    [createEmbeddedMaterial, noteId]
  );
  const insertEmbedded = useCallback(
    async (editor: NoteEditorInstance, kind: MaterialRefKind, code: string) => {
      const material = await createEmbedded(kind, code);
      insertEditorNode(editor, materialRefNode(material.id, kind));
      if (kind === 'quiz')
        await navigate({
          params: { quizId: material.id },
          search: quizEditSearch(router.state.location.href),
          to: '/quizzes/$quizId/edit',
        });
    },
    [createEmbedded, navigate, router]
  );

  const api = useMemo<NoteBlockDialogsApi>(
    () => ({
      createEmbedded,
      insertEmbedded,
      noteId,
      openFlashcards,
      openVisual,
      openYouTube,
    }),
    [
      createEmbedded,
      insertEmbedded,
      noteId,
      openFlashcards,
      openVisual,
      openYouTube,
    ]
  );

  useEffect(() => {
    mountedDialogsApi = api;
    return () => {
      if (mountedDialogsApi === api) mountedDialogsApi = null;
    };
  }, [api]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {visual && (
        <Suspense fallback={null}>
          <VisualBlockDialog
            block={visual.block}
            onClose={() => setVisual(null)}
            onSave={visual.onSave}
          />
        </Suspense>
      )}
      <FlashcardsDialog
        initialCode={flash?.code}
        onClose={() => setFlash(null)}
        onSave={async (code) => {
          await saveRef.current(code);
          setFlash(null);
        }}
        open={!!flash}
      />
      <YouTubeDialog
        initialUrl={youtube?.url}
        onClose={() => setYouTube(null)}
        onSave={(videoId) => {
          youtubeSaveRef.current(videoId);
          setYouTube(null);
        }}
        open={!!youtube}
      />
    </Ctx.Provider>
  );
}

function useResolvedDialogs(): NoteBlockDialogsApi | null {
  return useContext(Ctx) ?? mountedDialogsApi;
}

export function useNoteBlockDialogs(): NoteBlockDialogsApi {
  const ctx = useResolvedDialogs();
  if (!ctx)
    throw new Error(
      'useNoteBlockDialogs must be used within NoteBlockDialogsProvider'
    );
  return ctx;
}

/** Static material renderers do not mount authoring dialogs. */
export function useOptionalNoteBlockDialogs(): NoteBlockDialogsApi | null {
  return useResolvedDialogs();
}
