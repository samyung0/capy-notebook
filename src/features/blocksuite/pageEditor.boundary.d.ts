// What the app's tsconfig sees of ./pageEditor.ts (see tsconfig.json paths).
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { BlockIslands } from '@/features/notes/blocksuite/islands';

export function mountPageEditor(container: HTMLElement): () => void;

/** A note room's editor over its synced, id-adopted document, its material
 * refs published to `islands`; returns its unmount and read-only switch. */
export function mountNoteEditor(
  container: HTMLElement,
  room: { awareness: Awareness; doc: Y.Doc; id: string; readonly: boolean },
  islands: BlockIslands
): { setReadonly: (readonly: boolean) => void; unmount: () => void };
