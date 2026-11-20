import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import type {
  NoteEditorSaveState,
  NoteEditorStatus,
} from '@/features/notes/editorMode';

/** Where a note's embeds in Edit report their rooms' save state, so the
 * note's header says it for them too (Epo 2026-11-17, in place of each
 * embed's own Saved). */
type ReportEmbedState = (
  key: object,
  state: NoteEditorSaveState | null
) => void;

const EmbedStatusSink = createContext<ReportEmbedState | null>(null);
export const EmbedStatusProvider = EmbedStatusSink.Provider;

/** Least to most pressing; the note shows the most pressing of its own and
 * its embeds'. An embed still opening says nothing. */
const RANK: NoteEditorSaveState[] = [
  'saved',
  'synced',
  'syncing',
  'syncing-draft',
  'offline',
  'unsaved',
  'error',
];

/** The note's status with its embeds': a note still connecting or opening
 * says so alone. */
export function withEmbedStates(
  note: NoteEditorStatus | null,
  embeds: Iterable<NoteEditorSaveState>
): NoteEditorStatus | null {
  if (!note) return null;
  let rank = RANK.indexOf(note.saveState);
  if (rank < 0) return note;
  for (const state of embeds) rank = Math.max(rank, RANK.indexOf(state));
  return RANK[rank] === note.saveState
    ? note
    : { ...note, saveState: RANK[rank] };
}

/** For the note's frame: `onNote` takes the editor's own status and the
 * sink the embeds' states, and `onChange` hears what the header shows. */
export function useEmbedStatusSink(
  onChange: (status: NoteEditorStatus | null) => void
) {
  const change = useRef(onChange);
  change.current = onChange;
  const note = useRef<NoteEditorStatus | null>(null);
  const embeds = useRef(new Map<object, NoteEditorSaveState>());
  const shown = useRef<NoteEditorStatus | null | undefined>(undefined);
  const emit = useCallback(() => {
    const next = withEmbedStates(note.current, embeds.current.values());
    const last = shown.current;
    if (
      last !== undefined &&
      last?.saveState === next?.saveState &&
      last?.slowed === next?.slowed
    )
      return;
    shown.current = next;
    change.current(next);
  }, []);
  const onNote = useCallback(
    (status: NoteEditorStatus | null) => {
      note.current = status;
      emit();
    },
    [emit]
  );
  const sink = useCallback<ReportEmbedState>(
    (key, state) => {
      if (state) embeds.current.set(key, state);
      else embeds.current.delete(key);
      emit();
    },
    [emit]
  );
  return { onNote, sink };
}

/** An embed's report of its rooms' save state, if a note hears it; cleared
 * when it unmounts. Stable. */
export function useReportEmbedState() {
  const sink = useContext(EmbedStatusSink);
  const key = useRef({}).current;
  useEffect(() => () => sink?.(key, null), [sink, key]);
  return useCallback(
    (state: NoteEditorSaveState | null) => sink?.(key, state),
    [sink, key]
  );
}
