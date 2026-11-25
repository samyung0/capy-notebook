import type { GfxModel } from '@blocksuite/std/gfx';
import type { Store } from '@blocksuite/store';

/* Capy (vendor/blocksuite/README.md, local change 82): an element toolbar
 * action that writes several elements straight to their models asks first,
 * so a refused one writes nothing. Capy's board refuses one whose writes would
 * pass its room's cap (`src/features/blocksuite/boardFull.ts`). */

/** What the action writes on each element: `place`, its box (the alignment
 * menu's `updateXYWH`); `order`, its index (a reorder); `group`, a new group
 * holding them all (a lock of several). */
export type BoardWrite = 'group' | 'order' | 'place';

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
