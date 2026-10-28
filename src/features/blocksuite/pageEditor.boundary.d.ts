// What the app's tsconfig sees of ./pageEditor.ts (see tsconfig.json paths).
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

export function mountPageEditor(container: HTMLElement): () => void;

/** A note room's editor over its synced, id-adopted document; returns its
 * unmount. */
export function mountNoteEditor(
  container: HTMLElement,
  room: { awareness: Awareness; doc: Y.Doc; id: string; readonly: boolean }
): () => void;
