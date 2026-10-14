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
import type { Material, Question } from '@/api/types';
import { materialRefNode } from '@/features/materials/document';
import { holdInsertPlace, type NoteEditorInstance } from '../insertEditorNode';
import { YouTubeDialog } from '../YouTubeDialog';
import type { NoteVisualBlock } from './VisualBlockDialog';

const VisualBlockDialog = lazy(() => import('./VisualBlockDialog'));

type SaveYouTubeFn = (videoId: string) => void;

export interface NoteBlockDialogsApi {
  /** Create an embedded quiz or flashcard set under the note. */
  createEmbedded: (draft: NoteEmbedDraft) => Promise<Material>;
  /** Create the row first, then insert its reference block where the caret
   * was when the command ran. */
  insertEmbedded: (
    editor: NoteEditorInstance,
    draft: NoteEmbedDraft
  ) => Promise<void>;
  /** The note this editor is bound to; embedded materials are created under it. */
  noteId: string;
  openVisual: (
    block: NoteVisualBlock,
    onSave: (block: NoteVisualBlock) => void | Promise<void>
  ) => void;
  openYouTube: (initialUrl: string | undefined, onSave: SaveYouTubeFn) => void;
}

/** An embedded quiz or flashcard set to create under the note. */
export type NoteEmbedDraft =
  | { kind: 'quiz'; questions: Question[] }
  | { kind: 'flashcards'; cards: { back: string; front: string }[] };

const Ctx = createContext<NoteBlockDialogsApi | null>(null);

/**
 * Module-level handle for the mounted provider. Plate inline nodes (slash input)
 * sit under PlateContent and can miss React context after HMR or when rendered
 * through Plate's element pipeline; the editor store still works, so callers
 * fall back here while a NoteEditor is mounted.
 */
let mountedDialogsApi: NoteBlockDialogsApi | null = null;

/** Hosts the note's authoring popups and exposes imperative openers, used for
 * inserting new blocks (toolbar/slash) and editing existing ones. Quizzes and
 * flashcard sets are authored on their own edit pages. */
export function NoteBlockDialogsProvider({
  children,
  noteId,
}: {
  children: React.ReactNode;
  noteId: string;
}) {
  const { mutateAsync: createEmbeddedMaterial } = useCreateEmbeddedMaterial();
  const [visual, setVisual] = useState<{
    block: NoteVisualBlock;
    onSave: (block: NoteVisualBlock) => void | Promise<void>;
  } | null>(null);
  const [youtube, setYouTube] = useState<{ url?: string } | null>(null);
  const youtubeSaveRef = useRef<SaveYouTubeFn>(() => {});

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
    (draft: NoteEmbedDraft) => createEmbeddedMaterial({ ...draft, noteId }),
    [createEmbeddedMaterial, noteId]
  );
  // The new block is authored in place: Edit mode shows its editor. It goes
  // where the command ran, whatever the user did during the round trip.
  const insertEmbedded = useCallback(
    async (editor: NoteEditorInstance, draft: NoteEmbedDraft) => {
      const place = holdInsertPlace(editor);
      try {
        const material = await createEmbedded(draft);
        place.insert(materialRefNode(material.id, draft.kind));
      } finally {
        place.release();
      }
    },
    [createEmbedded]
  );

  const api = useMemo<NoteBlockDialogsApi>(
    () => ({
      createEmbedded,
      insertEmbedded,
      noteId,
      openVisual,
      openYouTube,
    }),
    [createEmbedded, insertEmbedded, noteId, openVisual, openYouTube]
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

/** The mounted note editor's dialogs, for editor transforms outside React
 * (a paste's pending references, pendingRefs.ts). */
export function noteBlockDialogs(): NoteBlockDialogsApi | null {
  return mountedDialogsApi;
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
