import type { PointerEventState } from '@blocksuite/affine/std';
import type { BaseTool, GfxModel } from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import { parseHTML } from 'linkedom';
import { beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Writes } from './boardFull';

vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
const { userToast } = await import('@/components/ui/userToast');
const {
  BOARD_WRITE_BYTES,
  gateElementUpdates,
  gateNudges,
  gatePresses,
  refusesAdds,
  refusesWrites,
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

/** A full board whose size stands `room` bytes under its cap, its checks
 * counted; `freeing` makes each check find that many bytes more. */
function fullBoard(room: number) {
  const store = {} as Store;
  let bytes = MAX - room;
  let freed = 0;
  const check = vi.fn(() => {
    bytes -= freed;
  });
  setBoardSizer(store, {
    check,
    pressed: vi.fn(),
    size: () => ({ bytes, max: MAX }),
  });
  setBoardFull(store, true);
  const freeing = (by: number) => {
    freed = by;
  };
  return { check, freeing, store };
}

// Epo 2026-11-25: a write of several elements on a full board goes only when
// a 16 B stub for each value it writes, and what those values may grow by
// (the guard's fourth review), fit under the cap. Review of 8d813a7cc,
// finding 6: the size as it stands is never below the board's, so a write it
// fits goes unmeasured (a held arrow key measured the whole board at every
// repeat); one it doesn't is measured, and goes once deletions freed room.
// Fails if a write that fits measures, a refusal acts on the size as it
// stood, or the growth is left out.
it('takes a write that fits the size as it stands unmeasured, and measures one that does not before refusing it', () => {
  const board = fullBoard(BOARD_WRITE_BYTES * 10);
  expect(
    refusesWrites(board.store, { elements: 5, grows: 0, values: 10 })
  ).toBe(false);
  expect(board.check).not.toHaveBeenCalled();
  expect(
    refusesWrites(board.store, { elements: 5, grows: 1, values: 10 })
  ).toBe(true);
  expect(board.check).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledOnce();
  board.freeing(1);
  expect(
    refusesWrites(board.store, { elements: 5, grows: 1, values: 10 })
  ).toBe(false);
  // One element's gesture always goes.
  expect(
    refusesWrites(board.store, { elements: 1, grows: 0, values: 100 })
  ).toBe(false);
  expect(userToast).toHaveBeenCalledOnce();
});

// Epo 2026-11-25: an arrow key nudges the selection, writing each element at
// every press; on a full board it is stopped before the board hears it when
// the stubs would pass the cap. Review of 8d813a7cc, finding 8: a key typed
// into a field on the board (the toolbar's inputs, a colour's, the menu's,
// the symbols panel's) is the field's. Fails if a nudge past the cap reaches
// the board, or an arrow key in a field is swallowed.
it("stops an arrow key that nudges several elements past a full board's cap, and leaves a field's keys alone", () => {
  const { document, Event } = parseHTML(
    '<div><p></p><input><span contenteditable="true"><b></b></span><math-field></math-field></div>'
  );
  const board = document.querySelector('div') as Element;
  const near = fullBoard(BOARD_WRITE_BYTES * 10 - 1);
  let writes: Writes | null = { elements: 10, grows: 0, values: 10 };
  gateNudges(board, near.store, () => writes);
  /** A key pressed on `target`: whether the board's gate stopped it. */
  const press = (target: string, keys: Partial<KeyboardEvent>) => {
    const event = Object.assign(
      new Event('keydown', { bubbles: true, cancelable: true }),
      { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      keys
    );
    const stop = vi.spyOn(event, 'stopPropagation');
    (board.querySelector(target) ?? board).dispatchEvent(event);
    expect(stop).toHaveBeenCalledTimes(event.defaultPrevented ? 1 : 0);
    return event.defaultPrevented;
  };
  expect(press('p', { key: 'ArrowLeft' })).toBe(true);
  expect(press('div', { key: 'ArrowUp', shiftKey: true })).toBe(true);
  expect(userToast).toHaveBeenCalledTimes(2);
  for (const field of ['input', 'b', 'math-field'])
    expect(press(field, { key: 'ArrowLeft' })).toBe(false);
  // Not a nudge: the board hears it.
  expect(press('p', { key: 'ArrowLeft', metaKey: true })).toBe(false);
  expect(press('p', { key: 'a' })).toBe(false);
  // Nothing moves, or one element.
  writes = null;
  expect(press('p', { key: 'ArrowLeft' })).toBe(false);
  writes = { elements: 1, grows: 0, values: 1 };
  expect(press('p', { key: 'ArrowLeft' })).toBe(false);
  expect(userToast).toHaveBeenCalledTimes(2);
});

// Epo 2026-11-25: the element toolbar writes every selected element, one
// call each in one task; on a full board the first call on the selection
// decides, so the change goes whole or not at all. Review of 8d813a7cc,
// finding 5: each element takes every value the call names, and a stroke's
// width its points and box too. Fourth review: a value written longer than
// it is stored keeps room for what it grows by. Fails if a change naming
// several values counts one an element, or a colour written longer counts its
// stub alone.
it("refuses a toolbar change of several elements past a full board's cap whole, counting each value, and takes it with room", async () => {
  const near = fullBoard(BOARD_WRITE_BYTES * 6);
  const updateElement = vi.fn();
  const crud = { updateElement };
  const selected = new Set(['a', 'b', 'c']);
  // Each stores what the changes below name (as a block stores its values).
  const doc = new Y.Doc();
  const model = (id: string) => {
    const yBlock = doc.getMap(id);
    for (const [key, value] of Object.entries({
      fillColor: 'red',
      fontFamily: 'Inter',
      fontStyle: 'normal',
      fontWeight: '400',
      lineWidth: 4,
      strokeColor: 'blue',
      xywh: '[0,0,10,10]',
    }))
      yBlock.set(`prop:${key}`, value);
    return { id, yBlock } as unknown as GfxModel;
  };
  gateElementUpdates(near.store, crud, (id) =>
    selected.has(id) ? [...selected].map(model) : null
  );
  const change = (props: Record<string, unknown>) => {
    for (const id of selected) crud.updateElement(id, props);
  };
  // A font: its family, weight and style.
  change({ fontFamily: 'Inter', fontStyle: 'normal', fontWeight: '400' });
  expect(updateElement).not.toHaveBeenCalled();
  expect(userToast).toHaveBeenCalledOnce();
  await Promise.resolve();
  // A stroke's width, its points and its box.
  change({ lineWidth: 8 });
  expect(updateElement).not.toHaveBeenCalled();
  await Promise.resolve();
  // A colour written longer: one value an element, and 26 B more each.
  change({ fillColor: '--affine-palette-shape-yellow' });
  expect(updateElement).not.toHaveBeenCalled();
  await Promise.resolve();
  change({ fillColor: 'red', strokeColor: 'blue' });
  expect(updateElement).toHaveBeenCalledTimes(3);
  await Promise.resolve();
  // One element's change always goes.
  selected.clear();
  selected.add('a');
  change({ fontFamily: 'Inter', fontStyle: 'normal', fontWeight: '400' });
  expect(updateElement).toHaveBeenCalledTimes(4);
  expect(userToast).toHaveBeenCalledTimes(3);
});
