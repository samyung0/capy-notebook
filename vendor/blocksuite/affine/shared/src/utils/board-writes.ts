import type { GfxModel } from '@blocksuite/std/gfx';
import type { Store } from '@blocksuite/store';

/* Capy (vendor/blocksuite/README.md, local change 82): an element toolbar
 * action or gesture that writes several elements straight to their models,
 * or adds one, asks first, so a refused one writes nothing. Capy's board
 * refuses one whose writes would pass its room's cap
 * (`src/features/blocksuite/boardFull.ts`). */

/** What the action writes: `place`, each element's box (the alignment menu's
 * `updateXYWH`); `order`, each one's index (a reorder); `scale`, each note's
 * box and scale (a note's Scale); `height`, each note's box and collapse (a
 * note's Auto or Customized height); `unlock`, each one's lock, or a group's
 * elements' (an Unlock ungroups a group); `style`, each mind map's style and
 * every node's look and place; `layout`, each mind map's layout and every
 * node's place; `merge`, a node and the nodes under it (the models after the
 * first) moved into another mind map (the first), taking its style, laid out
 * with it; `add`, a new element (a group holding them all at a Lock of
 * several, a new mind map for a node dragged off its map). */
export type BoardWrite =
  | 'add'
  | 'height'
  | 'layout'
  | 'merge'
  | 'order'
  | 'place'
  | 'scale'
  | 'style'
  | 'unlock';

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
