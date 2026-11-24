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
