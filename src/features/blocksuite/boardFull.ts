import type { Store } from '@blocksuite/affine/store';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** The stores of boards at their room's cap (`setRoomSize`). */
const full = new WeakSet<Store>();

export function setBoardFull(store: Store, on: boolean) {
  if (on) full.add(store);
  else full.delete(store);
}

/** Whether the board at `store` takes nothing that adds content now; one that
 * takes none says so. */
export function refusesAdds(store: Store) {
  if (!full.has(store)) return false;
  userToast({ title: m.editor_limit_remove_only(), variant: 'warning' });
  return true;
}
