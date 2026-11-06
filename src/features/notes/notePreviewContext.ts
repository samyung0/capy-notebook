import type { PlateEditor } from 'platejs/react';
import { createContext } from 'react';
import type { NoteSeat } from '@/features/collaboration/noteSeat';

/** An editor kept mounted behind the header's Preview: its overlays, palette and
 * players stand down (`useEditorHeld`), and its mounts hide under the host. */
export const EditorPreviewing = createContext(false);

/** Where Preview draws, under the editor's save strips, and how a strip's action
 * that needs the editor leaves it. Preview portals in from outside the editor,
 * so it reads none of the editor's contexts. */
export const NotePreviewHost = createContext<{
  exit: () => void;
  /** Whether the note can be edited at all right now, for the button's word. */
  setLocked: (locked: boolean) => void;
  setHost: (host: HTMLDivElement | null) => void;
  /** The seat of the editor on screen, which Preview's embeds join inside. */
  setSeat: (seat: NoteSeat | null) => void;
} | null>(null);

const valueListeners = new WeakMap<PlateEditor, Set<() => void>>();

/** Runs on every change to the editor's value, a collaborator's included. */
export function subscribeNoteValue(editor: PlateEditor, listener: () => void) {
  const listeners = valueListeners.get(editor) ?? new Set();
  valueListeners.set(editor, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteValueChanged(editor: PlateEditor) {
  for (const listener of valueListeners.get(editor) ?? []) listener();
}
