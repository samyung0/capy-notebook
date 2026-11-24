import type { PointerEventState } from '@blocksuite/affine/std';
import type { BaseTool } from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** The stores of boards at their room's cap (`setRoomSize`). */
const full = new WeakSet<Store>();
/** Each board's check of its size before something acts on it (the room's
 * `checkSize`): an encode when deletions may have freed it, whose size
 * reaches `setBoardFull` before it returns. */
const checks = new WeakMap<Store, () => void>();

export function setBoardFull(store: Store, on: boolean) {
  if (on) full.add(store);
  else full.delete(store);
}

export function setBoardCheck(store: Store, check: (() => void) | null) {
  if (check) checks.set(store, check);
  else checks.delete(store);
}

/** Checks the board's size now (`setBoardCheck`). */
export function checkBoardSize(store: Store) {
  checks.get(store)?.();
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
 * (a peer's drag would encode at each crossing). A double click checks the
 * size first, so a board deletions freed places its double-click note (the
 * flag `setRoomSize` sets at once). The hooks are the tool controller's
 * (`BaseTool.addHook`), which hear only presses that reach the canvas, never
 * the toolbar's or the menu's, and run before any tool's handler; BlockSuite
 * counts a double click at the second press's pointerup, before the DOM's
 * `dblclick`. */
export function gatePresses(
  store: Store,
  tool: Pick<BaseTool, 'addHook'>,
  adds: () => boolean,
  select: () => void
) {
  let refused = false;
  tool.addHook('pointerDown', (event: PointerEventState) => {
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
  tool.addHook('doubleClick', () => {
    if (refused) return false;
    if (full.has(store)) checkBoardSize(store);
  });
}
