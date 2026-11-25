import type { PointerEventState } from '@blocksuite/affine/std';
import type {
  BaseTool,
  InteractivityManager,
} from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** The stores of boards at their room's cap (`setRoomSize`). */
const full = new WeakSet<Store>();
/** The room's hold on a board's size (`ItemRoom`): `check`, run before
 * something acts on the size (an encode when deletions may have freed it,
 * whose size reaches `setBoardFull` before it returns), `pressed`, told of
 * each press on the board, and `size`, the size as it stands. */
export type BoardSizer = {
  check: () => void;
  pressed: () => void;
  size: () => { bytes: number; max: number } | null;
};
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

/** What a full board counts for each value a gesture writes on several
 * elements (Epo 2026-11-25). Yjs keeps a stub of about 10 B (its id, origin
 * and deleted mark) for every value overwritten. One element's back-to-back
 * overwrites merge (1,000 drags of one add 35 B), but a gesture on several
 * interleaves their writes, which then never merge: a select-all drag adds
 * about 10 B an element, and no fold collects them. 16 B is the margin over
 * that measure. */
export const BOARD_WRITE_BYTES = 16;

/** Whether a gesture writing `values` values of `elements` elements (one
 * each unless said) is refused: on a full board, its size checked first,
 * when the size and `BOARD_WRITE_BYTES` a value pass the cap, with the cap's
 * line. One element's writes merge, so they always go; a board that takes no
 * edits has nothing to refuse. */
export function refusesWrites(
  store: Store,
  elements: number,
  values = elements
) {
  if (elements <= 1 || store.readonly || !boardFull(store)) return false;
  const size = sizers.get(store)?.size();
  if (!size || size.bytes + BOARD_WRITE_BYTES * values <= size.max)
    return false;
  userToast({ title: m.editor_limit_remove_only(), variant: 'warning' });
  return true;
}

/** A drag of a selection (its moving set, the elements its groups hold
 * included, known only once the press picked it: a press outside the
 * selection selects what is under it), a resize or a rotation of several
 * elements writes each at its end (a rotation two values: its angle and its
 * place): on a full board it starts only when they fit (`refusesWrites`),
 * and refused it moves nothing. */
export function gateSelectionWrites(
  store: Store,
  interactivity: Pick<
    InteractivityManager,
    'handleElementMove' | 'handleElementResize' | 'handleElementRotate'
  >
) {
  const { handleElementMove, handleElementResize, handleElementRotate } =
    interactivity;
  interactivity.handleElementMove = (options) => {
    if (!refusesWrites(store, options.movingElements.length))
      handleElementMove.call(interactivity, options);
  };
  interactivity.handleElementResize = (options) => {
    if (!refusesWrites(store, options.elements.length))
      handleElementResize.call(interactivity, options);
  };
  interactivity.handleElementRotate = (options) => {
    const { length } = options.elements;
    if (!refusesWrites(store, length, 2 * length))
      handleElementRotate.call(interactivity, options);
  };
}

const NUDGES = new Set(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);

/** An arrow key nudges the selection, writing each element it moves
 * (`written`: none when it moves nothing) at every press: on a full board
 * the key is stopped before the board hears it unless they fit
 * (`refusesWrites`). Listens on `target` as it captures; returns the stop. */
export function gateNudges(
  target: EventTarget,
  store: Store,
  written: () => number
) {
  const refuse = (event: Event) => {
    const { altKey, ctrlKey, key, metaKey } = event as KeyboardEvent;
    if (
      !NUDGES.has(key) ||
      metaKey ||
      ctrlKey ||
      altKey ||
      !full.has(store) ||
      !refusesWrites(store, written())
    )
      return;
    event.preventDefault();
    event.stopPropagation();
  };
  target.addEventListener('keydown', refuse, true);
  return () => target.removeEventListener('keydown', refuse, true);
}

/** The element toolbar's changes (a colour, a stroke, a font, an alignment
 * or a spread) write every selected element through the board's
 * `updateElement`, one call each in one task: on a full board the first call
 * on what the selection writes (`written`: their number, 0 for another
 * element) decides for the task, so the change goes whole or not at all
 * (`refusesWrites`). */
export function gateElementUpdates(
  store: Store,
  crud: { updateElement: (id: string, props: Record<string, unknown>) => void },
  written: (id: string) => number
) {
  const { updateElement } = crud;
  let refused: boolean | null = null;
  crud.updateElement = (id, props) => {
    if (refused === null && full.has(store)) {
      const count = written(id);
      if (count > 1) {
        refused = refusesWrites(store, count);
        queueMicrotask(() => {
          refused = null;
        });
      }
    }
    if (!refused) updateElement(id, props);
  };
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
