import type { Store } from '@blocksuite/affine/store';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
const { userToast } = await import('@/components/ui/userToast');
const { refusesAdds, setBoardCheck, setBoardFull } = await import(
  './boardFull'
);

beforeEach(() => {
  vi.mocked(userToast).mockClear();
});

// Review 3 of the bytes room, finding 1: a board at its cap checks its size
// before it refuses an add; when deletions freed it, the check's exact size
// lifts the gate before the answer and the add is taken with no toast.
// Fails if a refusal acts on the size as it stood.
it('checks a full board before it refuses an add, and takes the add once it is freed', () => {
  const store = {} as Store;
  let exact = 'full';
  const check = vi.fn(() => setBoardFull(store, exact === 'full'));
  setBoardCheck(store, check);
  setBoardFull(store, true);
  expect(refusesAdds(store)).toBe(true);
  expect(check).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledOnce();
  exact = 'freed';
  expect(refusesAdds(store)).toBe(false);
  expect(userToast).toHaveBeenCalledOnce();
  // A board under its cap takes the add with no check.
  expect(refusesAdds(store)).toBe(false);
  expect(check).toHaveBeenCalledTimes(2);
});
