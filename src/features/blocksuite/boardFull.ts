import type { PointerEventState } from '@blocksuite/affine/std';
import type { BaseTool } from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** The stores of boards at their room's cap (`setRoomSize`). */
const full = new WeakSet<Store>();
/** The room's hold on a board's size (`ItemRoom`): `check`, run before
 * something acts on the size (an encode when deletions may have freed it,
 * whose size reaches `setBoardFull` before it returns), and `pressed`, told
 * of each press on the board. */
export type BoardSizer = { check: () => void; pressed: () => void };
const sizers = new WeakMap<Store, BoardSizer>();

export function setBoardFull(store: Store, on: boolean) {
  if (on) full.add(store);
  else full.delete(store);
}

export function setBoardSizer(store: Store, sizer: BoardSizer | null) {
  if (sizer) sizers.set(store, sizer);
  else sizers.delete(store);
}

/** Checks the board's size now (`setBoardSizer`). */
export function checkBoardSize(store: Store) {
  sizers.get(store)?.check();
}

/** Whether the board at `store` is at its cap once its size is checked. */
export function boardFull(store: Store) {
  if (!full.has(store)) return false;
  checkBoardSize(store);
  return full.has(store);
}

/** Whether the board at `store` takes nothing that adds content now, its
 * size checked first; one that takes none says so. */
export function refusesAdds(store: Store) {
  if (!boardFull(store)) return false;
  userToast({ title: m.editor_limit_remove_only(), variant: 'warning' });
  return true;
}

/** A press on the board's canvas with a tool that adds (`adds`) while the
 * board is full is refused, its size checked first (`refusesAdds`): the
 * cap's line says why, `select` puts select back and nothing of the press
 * reaches a tool. Only a press checks, never the gate coming on under a tool
 * (a peer's moves would encode at each crossing). A double click on empty
 * canvas (nothing `hit`) adds a note, or with the note off, as on a full
 * board, a canvas text label: on a full board it is refused the same way,
 * its size checked first, so a board deletions freed places its note (the
 * flag `setRoomSize` sets at once); one on an element edits it and goes on.
 * The hooks are the tool controller's (`BaseTool.addHook`), which hear only
 * presses that reach the canvas, never the toolbar's or the menu's, and run
 * before any tool's handler; BlockSuite counts a double click at the second
 * press's pointerup, before the DOM's `dblclick`. */
export function gatePresses(
  store: Store,
  tool: Pick<BaseTool, 'addHook'>,
  adds: () => boolean,
  hit: (event: PointerEventState) => boolean,
  select: () => void
) {
  let refused = false;
  tool.addHook('pointerDown', (event: PointerEventState) => {
    if (event.button === 0) sizers.get(store)?.pressed();
    refused = event.button === 0 && adds() && refusesAdds(store);
    if (!refused) return;
    event.raw.preventDefault();
    select();
    return false;
  });
  for (const name of [
    'pointerUp',
    'click',
    'tripleClick',
    'dragStart',
    'dragMove',
    'dragEnd',
  ] as const)
    tool.addHook(name, () => (refused ? false : undefined));
  tool.addHook('doubleClick', (event: PointerEventState) => {
    if (refused) return false;
    // A board that takes no edits (offline past its cap, read-only) has
    // nothing to refuse.
    if (store.readonly) return;
    if (full.has(store) && !hit(event) && refusesAdds(store)) return false;
  });
}
