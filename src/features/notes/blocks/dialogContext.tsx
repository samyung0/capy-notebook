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
import { useCreateEmbeddedMaterial, useWorkspace } from '@/api/hooks';
import type { Material, Question } from '@/api/types';
import {
  FILM_TYPE,
  filmNode,
  materialRefNode,
} from '@/features/materials/document';
import type { PlotBlock } from '@/features/questions/types';
import { holdInsertPlace, type NoteEditorInstance } from '../insertEditorNode';
import { YouTubeDialog } from '../YouTubeDialog';
import { EmbedPickDialog, type EmbedPickKind } from './EmbedPickDialog';

const PlotDialog = lazy(() =>
  import('./VisualBlockDialog').then((module) => ({
    default: module.PlotDialog,
  }))
);

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
  /** The note's Quiz or Flashcards (Epo 2026-11-27): a workspace holding
   * one opens the pick dialog, whose Insert puts the note's own copy of the
   * one picked where the command ran and whose Create new makes `draft`;
   * one holding none makes `draft` at once, as before. */
  insertStudy: (editor: NoteEditorInstance, draft: NoteEmbedDraft) => void;
  /** The note this editor is bound to; embedded materials are created under it. */
  noteId: string;
  /** A new plot's dialog, inserted on Save (charts and graphs go in at once
   * and open their own live dialog). */
  openPlot: (
    block: PlotBlock,
    onSave: (block: PlotBlock) => void | Promise<void>
  ) => void;
  openYouTube: (initialUrl: string | undefined, onSave: SaveYouTubeFn) => void;
  /** The note's Film: the pick dialog over the workspace's films, inserting
   * a film block where the command ran, or pointing the film block at `id`
   * at another (its toolbar's Replace). */
  pickFilm: (editor: NoteEditorInstance, replace?: { id: string }) => void;
}

/** An embedded quiz or flashcard set to create under the note: new, or the
 * note's own copy of `sourceId`. */
export type NoteEmbedDraft =
  | { kind: 'quiz'; questions: Question[] }
  | { kind: 'flashcards'; cards: { back: string; front: string }[] }
  | { kind: 'quiz' | 'flashcards'; sourceId: string };

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
/** An open pick dialog: what it lists, and what its Insert and Create new do. */
type Pick = {
  editor: NoteEditorInstance;
  kind: EmbedPickKind;
  insert: (id: string) => Promise<void> | void;
  create?: () => void;
  /** Lets go of the place the command held. */
  release: () => void;
};

export function NoteBlockDialogsProvider({
  children,
  noteId,
  workspaceId,
}: {
  children: React.ReactNode;
  noteId: string;
  /** The note's workspace, '' for a note in none. */
  workspaceId: string;
}) {
  const { mutateAsync: createEmbeddedMaterial } = useCreateEmbeddedMaterial();
  // Whether the workspace holds a quiz and a set (unknown until read, and
  // for a note in no workspace: the dialog opens then).
  // The workspace page owns a refused read (WorkspaceOpen's error state).
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const holds = useRef({ flashcards: true, quiz: true });
  holds.current = {
    flashcards: workspace?.hasFlashcards ?? true,
    quiz: workspace?.hasQuiz ?? true,
  };
  const [pick, setPick] = useState<Pick | null>(null);
  const [plot, setPlot] = useState<{
    block: PlotBlock;
    onSave: (block: PlotBlock) => void | Promise<void>;
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
  const openPlot = useCallback(
    (block: PlotBlock, onSave: (block: PlotBlock) => void | Promise<void>) =>
      setPlot({ block, onSave }),
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

  const insertStudy = useCallback(
    (editor: NoteEditorInstance, draft: NoteEmbedDraft) => {
      if (!holds.current[draft.kind]) {
        void insertEmbedded(editor, draft);
        return;
      }
      const place = holdInsertPlace(editor);
      const put = (material: Material) =>
        place.insert(materialRefNode(material.id, draft.kind));
      // Create new closes the dialog at once and holds the place on until
      // its row arrives; nothing goes in when the create fails.
      let creating = false;
      setPick({
        create: () => {
          creating = true;
          void createEmbedded(draft)
            .then(put, () => undefined)
            .finally(place.release);
        },
        editor,
        insert: (id) =>
          createEmbedded({ kind: draft.kind, sourceId: id }).then(put),
        kind: draft.kind,
        release: () => {
          if (!creating) place.release();
        },
      });
    },
    [createEmbedded, insertEmbedded]
  );
  const pickFilm = useCallback(
    (editor: NoteEditorInstance, replace?: { id: string }) => {
      if (replace) {
        setPick({
          editor,
          insert: (fileId) => {
            const at = editor.api.node({
              at: [],
              match: (node: { id?: string; type?: string }) =>
                node.type === FILM_TYPE && node.id === replace.id,
            })?.[1];
            if (at) editor.tf.setNodes({ fileId }, { at });
          },
          kind: 'film',
          release: () => {},
        });
        return;
      }
      const place = holdInsertPlace(editor);
      setPick({
        editor,
        insert: (fileId) => place.insert(filmNode(fileId)),
        kind: 'film',
        release: place.release,
      });
    },
    []
  );

  const api = useMemo<NoteBlockDialogsApi>(
    () => ({
      createEmbedded,
      insertEmbedded,
      insertStudy,
      noteId,
      openPlot,
      openYouTube,
      pickFilm,
    }),
    [
      createEmbedded,
      insertEmbedded,
      insertStudy,
      noteId,
      openPlot,
      openYouTube,
      pickFilm,
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
      {plot && (
        <Suspense fallback={null}>
          <PlotDialog
            block={plot.block}
            onClose={() => setPlot(null)}
            onSave={plot.onSave}
          />
        </Suspense>
      )}
      {pick && (
        <EmbedPickDialog
          key={pick.kind}
          kind={pick.kind}
          onClose={() => {
            pick.release();
            setPick(null);
          }}
          onClosed={() => pick.editor.tf.focus()}
          onCreate={pick.create}
          onInsert={pick.insert}
          workspaceId={workspaceId}
        />
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
