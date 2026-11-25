import type { GfxModel } from '@blocksuite/std/gfx';
import type { Store } from '@blocksuite/store';

/* Capy (vendor/blocksuite/README.md, local change 82): an element toolbar
 * action or gesture that writes several elements straight to their models,
 * or adds one, asks first, so a refused one writes nothing. Capy's board
 * refuses one whose writes would pass its room's cap
 * (`src/features/blocksuite/boardFull.ts`). */

/** What the action writes: `place`, each element's box (the alignment menu's
 * `updateXYWH`); `order`, each one's index (a reorder); `scale`, each note's
 * box and scale (a note's Scale); `add`, a new element (a group holding them
 * all at a Lock of several, a new mind map for a node dragged off its map). */
export type BoardWrite = 'add' | 'order' | 'place' | 'scale';

type Refuses = (models: GfxModel[], write: BoardWrite) => boolean;
const gates = new WeakMap<Store, Refuses>();

export const boardWrites = {
  /** Sets what refuses writes on `store`'s board; null clears it. */
  gate(store: Store, refuses: Refuses | null) {
    if (refuses) gates.set(store, refuses);
    else gates.delete(store);
  },
  /** Whether `write` on `models` is refused, before anything is written. */
  refuses(store: Store, models: GfxModel[], write: BoardWrite) {
    return gates.get(store)?.(models, write) ?? false;
  },
};
