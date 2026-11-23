import type { BlockModel, Store } from '@blocksuite/store';

/* Capy (vendor/blocksuite/README.md, local change 75): how a board note's
 * measured size (affine/blocks/note `note-size.ts`) reaches the labels of the
 * connectors attached to it (affine/gfx/connector `connector-watcher.ts`). A
 * size only the typist's tab shows moves no stored label; once it is saved,
 * the labels are placed inside the save's transaction. */

let local: BlockModel | null = null;
const saves = new Set<(store: Store, id: string) => void>();

export const noteSizeWrites = {
  /** Runs `write`, a change of `model`'s size that only this tab shows. */
  local(model: BlockModel, write: () => void) {
    const before = local;
    local = model;
    try {
      write();
    } finally {
      local = before;
    }
  },
  /** Whether the change under way is block `id`'s size only this tab shows. */
  isLocal(store: Store, id: string) {
    return local?.store === store && local.id === id;
  },
  /** Called inside the save's transaction once `model`'s size is stored. */
  saved(model: BlockModel) {
    saves.forEach(listener => listener(model.store, model.id));
  },
  /** Calls `listener` on every save; returns the call that stops it. */
  onSaved(listener: (store: Store, id: string) => void) {
    saves.add(listener);
    return () => {
      saves.delete(listener);
    };
  },
};
