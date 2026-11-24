import type { PointerEventState } from '@blocksuite/affine/std';
import type { BaseTool } from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
const { userToast } = await import('@/components/ui/userToast');
const { gatePresses, refusesAdds, setBoardCheck, setBoardFull } = await import(
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

type Hook = (event: PointerEventState) => boolean | undefined;

/** The tool controller's hooks as `gatePresses` adds them, run as a press
 * would run them: the first that answers false stops the tool's handler. */
function controller() {
  const hooks = new Map<string, Hook[]>();
  const tool = {
    addHook: (name: string, hook: Hook) => {
      hooks.set(name, [...(hooks.get(name) ?? []), hook]);
    },
  } as unknown as Pick<BaseTool, 'addHook'>;
  const preventDefault = vi.fn();
  const press = {
    button: 0,
    raw: { preventDefault },
  } as unknown as PointerEventState;
  /** Whether the tool hears `name`. */
  const heard = (name: string) =>
    !(hooks.get(name) ?? []).some((hook) => hook(press) === false);
  return { heard, preventDefault, tool };
}

// Review 4 finding 2: a press on the canvas with a tool that adds, on a full
// board, checks the size first and is refused with the cap's line: select
// is back and nothing of the press reaches the tool. Freed by deletions, the
// press is the tool's. Fails if the gate acts on the size as it stood or
// lets the rest of a refused press through.
it('checks a full board at a press with a tool that adds, and refuses the press while it is still full', () => {
  const store = {} as Store;
  let exact = 'full';
  const check = vi.fn(() => setBoardFull(store, exact === 'full'));
  setBoardCheck(store, check);
  setBoardFull(store, true);
  let adds = true;
  const select = vi.fn(() => {
    adds = false;
  });
  const { heard, preventDefault, tool } = controller();
  gatePresses(store, tool, () => adds, select);
  expect(heard('pointerDown')).toBe(false);
  expect(check).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledOnce();
  expect(select).toHaveBeenCalledOnce();
  expect(preventDefault).toHaveBeenCalledOnce();
  for (const name of ['dragStart', 'dragMove', 'dragEnd', 'pointerUp', 'click'])
    expect(heard(name)).toBe(false);
  // Select's own press adds nothing and checks nothing.
  expect(heard('pointerDown')).toBe(true);
  expect(heard('dragStart')).toBe(true);
  expect(check).toHaveBeenCalledOnce();
  adds = true;
  exact = 'freed';
  expect(heard('pointerDown')).toBe(true);
  expect(heard('dragStart')).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);
  expect(userToast).toHaveBeenCalledOnce();
});

// Review 4 finding 3: a double click on a full board checks its size before
// the double-click note is decided (its flag follows the size at once), and
// one under the cap checks nothing.
it('checks a full board at a double click, and a board under its cap not', () => {
  const store = {} as Store;
  const check = vi.fn(() => setBoardFull(store, false));
  setBoardCheck(store, check);
  setBoardFull(store, true);
  const { heard, tool } = controller();
  gatePresses(store, tool, () => false, vi.fn());
  expect(heard('pointerDown')).toBe(true);
  expect(heard('doubleClick')).toBe(true);
  expect(check).toHaveBeenCalledOnce();
  expect(heard('doubleClick')).toBe(true);
  expect(check).toHaveBeenCalledOnce();
});
