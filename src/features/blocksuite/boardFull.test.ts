import type { PointerEventState } from '@blocksuite/affine/std';
import type { BaseTool } from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
const { userToast } = await import('@/components/ui/userToast');
const {
  BOARD_WRITE_BYTES,
  gateElementUpdates,
  gateNudges,
  gatePresses,
  gateSelectionWrites,
  refusesAdds,
  setBoardFull,
  setBoardSizer,
} = await import('./boardFull');

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
  setBoardSizer(store, { check, pressed: vi.fn(), size: () => null });
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
  const pressed = vi.fn();
  setBoardSizer(store, { check, pressed, size: () => null });
  setBoardFull(store, true);
  let adds = true;
  const select = vi.fn(() => {
    adds = false;
  });
  const { heard, preventDefault, tool } = controller();
  gatePresses(
    store,
    tool,
    () => adds,
    () => false,
    select
  );
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
  // The room hears of every press (it arms its next idle measure).
  expect(pressed).toHaveBeenCalledTimes(3);
});

// Review 4 finding 3, review 5 finding 3: a double click on empty canvas
// adds a note, or with the note off (a full board) a canvas text label. On
// a full board it checks the size first and, still full, is refused with
// the cap's line before either is decided; on an element (editing it) it
// goes on; once deletions freed the board it is the tool's, whose note
// flag followed the size at once. Fails if a full board's double click
// adds a label, or acts on the size as it stood.
it("refuses a full board's double click on empty canvas, its size checked first, and not one on an element", () => {
  const store = {} as Store;
  let exact = 'full';
  const check = vi.fn(() => setBoardFull(store, exact === 'full'));
  setBoardSizer(store, { check, pressed: vi.fn(), size: () => null });
  setBoardFull(store, true);
  let element = false;
  const { heard, tool } = controller();
  gatePresses(
    store,
    tool,
    () => false,
    () => element,
    vi.fn()
  );
  expect(heard('pointerDown')).toBe(true);
  expect(heard('doubleClick')).toBe(false);
  expect(check).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledOnce();
  element = true;
  expect(heard('doubleClick')).toBe(true);
  expect(userToast).toHaveBeenCalledOnce();
  element = false;
  exact = 'freed';
  expect(heard('doubleClick')).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);
  expect(userToast).toHaveBeenCalledOnce();
  // Under the cap a double click checks nothing.
  expect(heard('doubleClick')).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);
});

// Bytes room T8: a board that takes no edits (offline past its cap, its
// store read-only) says nothing at a double click: the remove-only line
// would promise an edit it cannot take.
it("leaves a read-only full board's double click alone", () => {
  const store = { readonly: true } as Store;
  const check = vi.fn();
  setBoardSizer(store, { check, pressed: vi.fn(), size: () => null });
  setBoardFull(store, true);
  const { heard, tool } = controller();
  gatePresses(
    store,
    tool,
    () => false,
    () => false,
    vi.fn()
  );
  expect(heard('doubleClick')).toBe(true);
  expect(check).not.toHaveBeenCalled();
  expect(userToast).not.toHaveBeenCalled();
});

const MAX = 4 * 1024 * 1024;

/** A full board whose size stands `room` bytes under its cap, its check
 * counted. */
function fullBoard(room: number) {
  const store = {} as Store;
  const check = vi.fn();
  setBoardSizer(store, {
    check,
    pressed: vi.fn(),
    size: () => ({ bytes: MAX - room, max: MAX }),
  });
  setBoardFull(store, true);
  return { check, store };
}

/** Elements as the board's interactivity takes them: only their number
 * counts. */
const elements = (count: number) =>
  Array.from({ length: count }, (_, at) => ({ id: `e${at}` }));

/** The board's interactivity, gated: what started. */
function interactivity(store: Store) {
  const started = {
    handleElementMove: vi.fn(),
    handleElementResize: vi.fn(),
    handleElementRotate: vi.fn(),
  };
  const gated = { ...started };
  gateSelectionWrites(store, gated as never);
  return {
    move: (count: number) =>
      gated.handleElementMove({ movingElements: elements(count) } as never),
    resize: (count: number) =>
      gated.handleElementResize({ elements: elements(count) } as never),
    rotate: (count: number) =>
      gated.handleElementRotate({ elements: elements(count) } as never),
    started,
  };
}

// Epo 2026-11-25: a drag of several elements writes each at its end, and
// their interleaved writes leave a stub of about 10 B each that never
// merges. On a full board it is refused, its size checked first, when 16 B
// an element would pass the cap, and nothing starts; with room for them it
// goes; one element's drag merges and always goes. Fails if a select-all
// drag on a full board can pass the cap.
it('refuses a drag of several elements on a full board within 16 B each of its cap, and starts nothing', () => {
  const near = fullBoard(BOARD_WRITE_BYTES * 100 - 1);
  const gated = interactivity(near.store);
  gated.move(100);
  expect(near.check).toHaveBeenCalledOnce();
  expect(gated.started.handleElementMove).not.toHaveBeenCalled();
  expect(userToast).toHaveBeenCalledOnce();
  gated.resize(100);
  expect(gated.started.handleElementResize).not.toHaveBeenCalled();
  gated.move(1);
  expect(gated.started.handleElementMove).toHaveBeenCalledOnce();
  const roomy = fullBoard(BOARD_WRITE_BYTES * 100);
  const fits = interactivity(roomy.store);
  fits.move(100);
  fits.resize(100);
  expect(fits.started.handleElementMove).toHaveBeenCalledOnce();
  expect(fits.started.handleElementResize).toHaveBeenCalledOnce();
  // A rotation writes two values an element: its angle and its place.
  fits.rotate(100);
  expect(fits.started.handleElementRotate).not.toHaveBeenCalled();
  fits.rotate(50);
  expect(fits.started.handleElementRotate).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledTimes(3);
});

it('checks nothing at a drag on a board under the line', () => {
  const { check, store } = fullBoard(0);
  setBoardFull(store, false);
  const gated = interactivity(store);
  gated.move(5000);
  expect(check).not.toHaveBeenCalled();
  expect(gated.started.handleElementMove).toHaveBeenCalledOnce();
});

// Epo 2026-11-25: an arrow key nudges the selection, writing each element at
// every press; on a full board it is stopped before the board hears it when
// the stubs would pass the cap, and goes with room or with one element.
it("stops an arrow key that nudges several elements past a full board's cap before the board hears it", () => {
  const near = fullBoard(BOARD_WRITE_BYTES * 10 - 1);
  const board = new EventTarget();
  let written = 10;
  gateNudges(board, near.store, () => written);
  /** A key pressed on the board: whether it was stopped there. */
  const press = (keys: Partial<KeyboardEvent>) => {
    const event = Object.assign(
      new Event('keydown', { cancelable: true }),
      { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      keys
    );
    const stop = vi.spyOn(event, 'stopPropagation');
    board.dispatchEvent(event);
    expect(stop).toHaveBeenCalledTimes(event.defaultPrevented ? 1 : 0);
    return event.defaultPrevented;
  };
  expect(press({ key: 'ArrowLeft' })).toBe(true);
  expect(press({ key: 'ArrowUp', shiftKey: true })).toBe(true);
  expect(userToast).toHaveBeenCalledTimes(2);
  // Not a nudge: the board hears it.
  expect(press({ key: 'ArrowLeft', metaKey: true })).toBe(false);
  expect(press({ key: 'a' })).toBe(false);
  written = 1;
  expect(press({ key: 'ArrowLeft' })).toBe(false);
  expect(userToast).toHaveBeenCalledTimes(2);
});

// Epo 2026-11-25: the element toolbar writes every selected element, one
// call each in one task; on a full board the first call on the selection
// decides, so the change goes whole or not at all.
it("refuses a toolbar change of several elements past a full board's cap whole, and takes it with room", async () => {
  const near = fullBoard(BOARD_WRITE_BYTES * 3 - 1);
  const updateElement = vi.fn();
  const crud = { updateElement };
  const selected = new Set(['a', 'b', 'c']);
  gateElementUpdates(near.store, crud, (id) =>
    selected.has(id) ? selected.size : 0
  );
  for (const id of selected) crud.updateElement(id, { fillColor: 'red' });
  expect(updateElement).not.toHaveBeenCalled();
  expect(userToast).toHaveBeenCalledOnce();
  await Promise.resolve();
  // One element's change always goes.
  selected.clear();
  selected.add('a');
  crud.updateElement('a', { fillColor: 'red' });
  expect(updateElement).toHaveBeenCalledOnce();
  const roomy = fullBoard(BOARD_WRITE_BYTES * 3);
  const update = vi.fn();
  const fits = { updateElement: update };
  gateElementUpdates(roomy.store, fits, () => 3);
  for (const id of ['a', 'b', 'c'])
    fits.updateElement(id, { fillColor: 'red' });
  expect(update).toHaveBeenCalledTimes(3);
  expect(userToast).toHaveBeenCalledOnce();
});
