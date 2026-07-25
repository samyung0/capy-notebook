import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FlashcardsDialog } from './FlashcardsDialog';
import { QuizDialog } from './QuizDialog';

type SaveFn = (code: string) => void;

export interface NoteBlockDialogsApi {
  openFlashcards: (initialCode: string | undefined, onSave: SaveFn) => void;
  openQuiz: (initialCode: string | undefined, onSave: SaveFn) => void;
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
}: {
  children: React.ReactNode;
}) {
  const [quiz, setQuiz] = useState<{ code?: string } | null>(null);
  const [flash, setFlash] = useState<{ code?: string } | null>(null);
  const saveRef = useRef<SaveFn>(() => {});

  const openQuiz = useCallback(
    (initialCode: string | undefined, onSave: SaveFn) => {
      saveRef.current = onSave;
      setQuiz({ code: initialCode });
    },
    []
  );
  const openFlashcards = useCallback(
    (initialCode: string | undefined, onSave: SaveFn) => {
      saveRef.current = onSave;
      setFlash({ code: initialCode });
    },
    []
  );

  const api = useMemo<NoteBlockDialogsApi>(
    () => ({ openFlashcards, openQuiz }),
    [openQuiz, openFlashcards]
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
      <QuizDialog
        initialCode={quiz?.code}
        onClose={() => setQuiz(null)}
        onSave={(code) => {
          saveRef.current(code);
          setQuiz(null);
        }}
        open={!!quiz}
      />
      <FlashcardsDialog
        initialCode={flash?.code}
        onClose={() => setFlash(null)}
        onSave={(code) => {
          saveRef.current(code);
          setFlash(null);
        }}
        open={!!flash}
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
