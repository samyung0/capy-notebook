import {
  ConnectorElementModel,
  GroupElementModel,
  MindmapElementModel,
} from '@blocksuite/affine/model';
import { boardWrites } from '@blocksuite/affine/shared/utils';
import type { CommandManager, PointerEventState } from '@blocksuite/affine/std';
import {
  type BaseTool,
  type GfxGroupCompatibleInterface,
  type GfxModel,
  GfxPrimitiveElementModel,
  type InteractivityManager,
  isGfxGroupCompatibleModel,
} from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import * as Y from 'yjs';
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
 * elements (Epo 2026-11-25). Yjs keeps a stub (its id, origin and deleted
 * mark) for every value overwritten, its clock twice: in the new value's
 * origin and in the deleted range. Back-to-back overwrites of one value by
 * one tab merge (1,000 drags of one shape add 35 B), but not where values
 * alternate: a gesture on several elements interleaves their writes, and one
 * element's gesture writing two or more values (a connector's ends and
 * label, a rotation's angle and place, a text label's box and font size)
 * interleaves its own. Those never merge, and no fold collects them. What a
 * select-all move adds to the room's collected state (`collectedSize`) was
 * measured at 12 B an element on a fresh board, 14 B once its clocks passed
 * 10^5 and 16 B past 2.1 × 10^6 (3- and 4-byte clocks); a value written for
 * the first time adds its key too (`NEW_KEY`). A value written longer than
 * it was adds the difference besides (`Writes.grows`). */
export const BOARD_WRITE_BYTES = 16;

/** What a write reaches: its elements, the values it writes on them (a stub
 * each, `BOARD_WRITE_BYTES`) and the bytes those values may grow by, each at
 * the longest its format allows less what it stores now (`anyBytes`). */
export type Writes = { elements: number; grows: number; values: number };

/** The bytes a full board keeps for `writes`. */
export const bytesOf = (writes: Writes) =>
  BOARD_WRITE_BYTES * writes.values + writes.grows;

/** How a gesture writes each element: a drag or an arrow key moves it, the
 * alignment menu, an arrange and a resize to one size place it
 * (`updateXYWH`), the selection frame resizes or rotates it, a note's Scale
 * scales it and its Auto or Customized height sets its height, a mind map's
 * Style restyles it and its Layout lays it out again. */
export type Gesture =
  | 'height'
  | 'layout'
  | 'move'
  | 'place'
  | 'resize'
  | 'rotate'
  | 'scale'
  | 'style';

/** The elements a write on `models` reaches: what their groups hold, and
 * every node of a mind map one of them is in or holds (a node dragged moves
 * its whole map: `MindMapDragExtension`, `updateXYWH`'s layout). */
export function elementsWritten(models: Iterable<GfxModel>) {
  const written = new Set<GfxModel>();
  const add = (model: GfxModel) => {
    if (written.has(model)) return;
    written.add(model);
    if (isGfxGroupCompatibleModel(model)) model.descendantElements.forEach(add);
    if (model.group instanceof MindmapElementModel) add(model.group);
  };
  for (const model of models) add(model);
  return written;
}

/** A value written for the first time adds its item's header and key
 * beside its stub, two values' worth: a note's collapse and collapsed height
 * added 25 B of headers between them besides their keys and values, so 32 B
 * holds a key of 19 characters (each value's own bytes count as growth). */
const NEW_KEY = 2;

/* How much a written value may grow (the guard's fourth review): Yjs keeps
 * the new value whole and the old one as a stub, so a value written longer
 * than it was adds the difference. BlockSuite's `Bound.serialize` writes 17
 * significant digits at any zoom but 1, so a drag of shapes placed on whole
 * numbers grows each box by about 30 B. Each bound is the longest the
 * value's format allows less what it stores now, one read a value and no
 * encode; positions are never rounded (that would change stored data). */

/** The value `model` stores under `key`, as the room holds it (not a size
 * it shows or a stashed value). */
const stored = (model: GfxModel, key: string): unknown =>
  model instanceof GfxPrimitiveElementModel
    ? model.yMap.get(key)
    : model.yBlock.get(`prop:${key}`);

const storesKey = (model: GfxModel, key: string) =>
  model instanceof GfxPrimitiveElementModel
    ? model.yMap.has(key)
    : model.yBlock.has(`prop:${key}`);

const varUintBytes = (n: number) =>
  n < 2 ** 7 ? 1 : n < 2 ** 14 ? 2 : n < 2 ** 21 ? 3 : n < 2 ** 28 ? 4 : 5;

/** A string's UTF-8 bytes as lib0 writes it (`TextEncoder.encodeInto`): a
 * surrogate pair 4, a lone surrogate 3 (as U+FFFD). */
const utf8Bytes = (text: string) => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (code < 0x80) bytes += 1;
    else if (code < 0x8_00) bytes += 2;
    else if (
      code < 0xd8_00 ||
      code >= 0xdc_00 ||
      !(next >= 0xdc_00 && next < 0xe0_00)
    )
      bytes += 3;
    else {
      bytes += 4;
      i++;
    }
  }
  return bytes;
};

/** The bytes lib0's `writeAny` stores `value` in, as a Y.Map's value: a
 * type byte, then an integer within 2^31 as a varint (6 bits, then 7 a
 * byte), another number as a float32 when it is one (4) or a float64 (8); a
 * string or bytes their length's varint and their bytes (UTF-8); an array or
 * an object its length's varint and each entry, an object's key as a string;
 * nothing else more. A shared type (a block's object value) is counted as
 * its JSON. */
export function anyBytes(value: unknown): number {
  if (value instanceof Y.AbstractType) return anyBytes(value.toJSON());
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) <= 0x7f_ff_ff_ff) {
      const n = Math.abs(value);
      return n < 2 ** 6
        ? 2
        : n < 2 ** 13
          ? 3
          : n < 2 ** 20
            ? 4
            : n < 2 ** 27
              ? 5
              : 6;
    }
    return Math.fround(value) === value ? 5 : 9;
  }
  if (typeof value === 'bigint') return 9;
  if (typeof value === 'string') {
    const n = utf8Bytes(value);
    return 1 + varUintBytes(n) + n;
  }
  if (value instanceof Uint8Array)
    return 1 + varUintBytes(value.length) + value.length;
  if (Array.isArray(value))
    return value.reduce<number>(
      (sum, entry) => sum + anyBytes(entry),
      1 + varUintBytes(value.length)
    );
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.reduce(
      (sum, [key, entry]) => sum + anyBytes(key) - 1 + anyBytes(entry),
      1 + varUintBytes(entries.length)
    );
  }
  return 1;
}

/** A number at its longest: a float64, its type byte and 8. One stored
 * whole takes 2 at least; one written for the first time grows from none. */
const NUMBER_LONGEST = 9;
const numberGrowth = (value: unknown) =>
  NUMBER_LONGEST - (typeof value === 'number' ? anyBytes(value) : 0);

/** The longest box, `[x,y,w,h]` with each number as JS writes it (the
 * shortest that reads back, at most 17 significant digits): 25 characters at
 * most, a sign, `0.`, five zeros and 17 digits (-0.0000012345678901234567;
 * below 10^-6 and from 10^21 JS writes an exponent, at most 24:
 * -1.7976931348623157e+308), so 4 × 25 + 5. Its length's varint is one byte
 * either way (under 128). */
const XYWH_LONGEST = 105;
const boxGrowth = (model: GfxModel) =>
  XYWH_LONGEST - String(stored(model, 'xywh') ?? '').length;

/** A move keeps a box's width and height: a drag sets `moveDelta` of the
 * box (the snap shifting its delta alone), an arrow key its `x` and `y`. So
 * only `x` and `y` may grow, to 25 characters each, the width and height
 * written again as JS writes their numbers. A box that does not read falls
 * back to `boxGrowth`; one that may get shorter grows by nothing (an arrow
 * key sends each element's move as its own update, so one box's shrinking
 * may come after another's growth). */
const moveGrowth = (model: GfxModel) => {
  const xywh = String(stored(model, 'xywh') ?? '');
  let box: unknown;
  try {
    box = JSON.parse(xywh);
  } catch {
    return boxGrowth(model);
  }
  if (!(Array.isArray(box) && box.length === 4)) return boxGrowth(model);
  const [, , w, h] = box.map((n) => String(Number(n)));
  return Math.max(0, 2 * 25 + w.length + h.length + 5 - xywh.length);
};

/** A connector's free end, `{position: [x, y]}`, grows by its two numbers
 * (`moveTo` writes them); a bound end is left as it is. */
const endGrowth = (end: unknown) => {
  const { id, position } = (end ?? {}) as { id?: string; position?: number[] };
  return id ? 0 : numberGrowth(position?.[0]) + numberGrowth(position?.[1]);
};

/** A connector's label's place, `[x, y, w, h]`, by its four numbers (and
 * the array's two bytes when it has none yet). */
const labelGrowth = (connector: ConnectorElementModel) => {
  const label = stored(connector, 'labelXYWH') as unknown[] | undefined;
  return [0, 1, 2, 3].reduce(
    (sum, i) => sum + numberGrowth(label?.[i]),
    label ? 0 : 2
  );
};

/** The longest of `models`' indexes, whole and their integer parts (a
 * fractional-indexing key's head says its integer part's length: `a` 2, `b`
 * 3, … `z` 27, `Z` 2, `Y` 3, … `A` 27). */
export type IndexLengths = { integer: number; whole: number };

const integerLength = (index: string) => {
  const head = index.charCodeAt(0);
  if (head >= 97 && head <= 122) return head - 97 + 2;
  if (head >= 65 && head <= 90) return 90 - head + 2;
  return index.length;
};

export const longestIndex = (models: Iterable<GfxModel>): IndexLengths => {
  let integer = 0;
  let whole = 0;
  for (const { index } of models) {
    integer = Math.max(integer, integerLength(index));
    whole = Math.max(whole, index.length);
  }
  return { integer, whole };
};

/** How a write makes its new indexes (fractional-indexing's
 * `generateKeyBetween`, its key at most one character longer than the
 * longer of the two it goes between): `end`, one past the last or before the
 * first of its siblings each (Bring to Front, Send to Back:
 * `getReorderedIndex`'s `(last, null)` and `(null, first)`), the last one
 * made the next one's neighbour; `split`, n bisected between two siblings at
 * once (an ungroup's `generateNKeysBetween`); `step`, each between two
 * siblings (Bring Forward, Send Backward), either one it made before. */
export type Keys = 'end' | 'split' | 'step';

/** The longest the i-th of n new keys is when every key they go between is
 * at most `longest.whole` long. Every path: a neighbour is a key on the board
 * or one this write made, so the i-th is at most `whole` + i (a `step` chain
 * does grow: 1,000 adjacent elements brought forward top first reach 170
 * characters). `end`: a key past `a` alone is `a`'s integer part plus one
 * (its fraction dropped), before `b` alone its integer part less one; an
 * integer of ℓ characters has 62^(ℓ - 1) values, so after the first step to
 * a longer one each further takes 62² keys at least: at most
 * `longest.integer` + 1 + ⌊log₆₂ n⌋ (the largest and smallest integers, 27
 * characters, where it goes on with fractions, aside). `split`:
 * `generateNKeysBetween(a, b, n)` takes the key between them and halves n on
 * each side, so a key is at most ⌈log₂(n + 1)⌉ longer than `whole` (its
 * one-sided fallbacks, as `end`, stay within it). */
const keyLongest = (
  keys: Keys,
  longest: IndexLengths,
  n: number,
  i: number
) => {
  let bound = longest.whole + i;
  if (keys === 'end' && longest.integer < 27) {
    let steps = 0;
    for (let m = 62; m <= n; m *= 62) steps++;
    bound = Math.min(bound, longest.integer + 1 + steps);
  }
  if (keys === 'split') {
    let halvings = 0;
    while (2 ** halvings < n + 1) halvings++;
    bound = Math.min(bound, longest.whole + halvings);
  }
  return bound;
};

/** What new indexes for `models`, made as `keys` says next to keys at most
 * `longest` long, grow by: each at its longest (`keyLongest`) less its
 * length now, a key that may get shorter as nothing (the room judges each
 * change alone, so one key's shrinking may come after another's growth). */
export function indexGrowth(
  models: readonly GfxModel[],
  longest: IndexLengths,
  keys: Keys
) {
  let grows = 0;
  for (const [i, model] of models.entries())
    grows += Math.max(
      0,
      keyLongest(keys, longest, models.length, i + 1) - model.index.length
    );
  return grows;
}

/** A note's stored `edgeless` values (its own map). */
const edgelessOf = (model: GfxModel) => {
  const edgeless = stored(model, 'edgeless');
  return (edgeless instanceof Y.Map ? edgeless.toJSON() : (edgeless ?? {})) as {
    collapse?: boolean;
    collapsedHeight?: number;
    scale?: number;
  };
};

/** What a resize writes on an element besides its box: a text label its
 * font size (a corner) or wrap (a side), a note its scale (`NEW_KEY` the
 * first time), a stroke its points (vendor/blocksuite local change 81), a
 * plane its view's corner (and its `fit`, when it fitted: `fitted`). */
const RESIZED: Record<string, number> = {
  'affine:note': 1 + NEW_KEY,
  brush: 2,
  highlighter: 2,
  plane: 3,
  text: 2,
};

/** A plane that fits its marks stops at a resize's start (`boardPlane.ts`
 * `onResizeStart`), one value more; one that does not writes nothing. */
const fitted = (model: GfxModel) => (stored(model, 'fit') === true ? 1 : 0);

/** What a mind map's Style writes on each node: up to ten of its values (its
 * colours, font, padding, radius and shadow) and its box once, measured in
 * the room's collected state at 117 B a node at most over every change of
 * style of a 21-node map on a fresh board, 125 B past 10^5 and 133 B past
 * 2.1 × 10^6: 9 values' worth (`BOARD_WRITE_BYTES`). Its Layout writes each
 * node's box and a first-level node's place in the tree, measured on a map
 * of first-level nodes alone at 18, 20 and 22 B a node: 2. */
const NODE_STYLED = 9;
const NODE_LAID_OUT = 2;

/** The values `gesture` writes on `model`, at most: a group's box is its
 * elements' and writes nothing; a mind map's tree takes a dragged node's new
 * place, its style or its layout; a mind map's node its style
 * (`NODE_STYLED`) or its place when its map is restyled or laid out again
 * (`NODE_LAID_OUT`); a connector writes its free ends and its label
 * (`moveTo`, its resize and rotation); a rotation an angle and a place; a
 * note placed its collapse and collapsed height too (`updateXYWH`), scaled
 * its scale (each `NEW_KEY` the first time), its height set its collapse. A
 * note showing a size it measured stores it first (vendor/blocksuite local
 * change 75): one more. */
export function valuesWritten(model: GfxModel, gesture: Gesture) {
  if (model instanceof MindmapElementModel)
    return gesture === 'move' || gesture === 'style' || gesture === 'layout'
      ? 1
      : 0;
  if (isGfxGroupCompatibleModel(model)) return 0;
  if (model.group instanceof MindmapElementModel) {
    if (gesture === 'style') return NODE_STYLED;
    if (gesture === 'layout') return NODE_LAID_OUT;
  }
  if (model instanceof ConnectorElementModel) return 3;
  const kind =
    model instanceof GfxPrimitiveElementModel ? model.type : model.flavour;
  const shown = kind === 'affine:note' ? 1 : 0;
  if (gesture === 'rotate') return 2 + shown;
  if (gesture === 'resize') return (RESIZED[kind] ?? 1) + shown + fitted(model);
  if (gesture === 'place' && kind === 'affine:note')
    return 1 + 2 * NEW_KEY + shown;
  if (gesture === 'scale') return 1 + NEW_KEY + shown;
  if (gesture === 'height') return 2 + shown;
  return 1 + shown;
}

/** A mind map's node other than its root (`MindMapDragExtension` drags it
 * alone, into another branch or map). */
const isBranch = (model: GfxModel) =>
  model.group instanceof MindmapElementModel &&
  model.group.tree?.id !== model.id;

/** What `gesture`'s values on `model` grow by at most (`valuesWritten`):
 * a box (`XYWH_LONGEST`) and the numbers written with it, a rotation's
 * angle, a text label's font size, a plane's view corner, a note's scale and
 * collapsed height; a connector its free ends and its label's place; a mind
 * map's style and layout are whole numbers, written as such. A stroke's
 * points keep their length (four bytes a value, vendor/blocksuite local
 * change 79). */
export function growthOf(model: GfxModel, gesture: Gesture) {
  if (model instanceof MindmapElementModel || isGfxGroupCompatibleModel(model))
    return 0;
  // A mind map lays its nodes out after a drag and a note may store a size
  // it measures with its move (vendor/blocksuite local change 75): their
  // boxes keep `boxGrowth` below.
  if (model instanceof ConnectorElementModel)
    return (
      endGrowth(stored(model, 'source')) +
      endGrowth(stored(model, 'target')) +
      (model.hasLabel() ? labelGrowth(model) : 0)
    );
  const box = boxGrowth(model);
  if (model.group instanceof MindmapElementModel) return box;
  const kind =
    model instanceof GfxPrimitiveElementModel ? model.type : model.flavour;
  const note = kind === 'affine:note' ? edgelessOf(model) : null;
  if (gesture === 'move' && !note) return moveGrowth(model);
  if (gesture === 'rotate') return box + numberGrowth(stored(model, 'rotate'));
  if (gesture === 'resize') {
    if (kind === 'text') return box + numberGrowth(stored(model, 'fontSize'));
    if (kind === 'plane')
      return (
        box +
        numberGrowth(stored(model, 'x0')) +
        numberGrowth(stored(model, 'y0'))
      );
    return box + (note ? numberGrowth(note.scale) : 0);
  }
  if (note && gesture === 'place')
    return (
      box +
      numberGrowth(note.collapsedHeight) +
      (note.collapse === undefined ? 1 : 0)
    );
  if (note && gesture === 'scale') return box + numberGrowth(note.scale);
  return box;
}

/** What `gesture` on `models` writes (`elementsWritten`, `valuesWritten`,
 * `growthOf`), with the label of each labelled connector hanging on one of
 * them (`connectorsOf`), which the tab moving its end places
 * (vendor/blocksuite local change 63). A mind map's node dragged alone may
 * land in another branch: its place in the tree is written again (the map's
 * one value, a few bytes within the Style count of its nodes), its map lays
 * out again and restyles what moved (Style one colours by first-level
 * branch, the others by depth), at worst the whole map at its Style count. */
export function writesOf(
  models: Iterable<GfxModel>,
  gesture: Gesture,
  connectorsOf: (id: string) => Iterable<ConnectorElementModel>
): Writes {
  const list = [...models];
  const written = elementsWritten(list);
  const [first] = list;
  const branch =
    gesture === 'move' && list.length === 1 && isBranch(first)
      ? (first.group as MindmapElementModel)
      : null;
  const each = branch ? 'style' : gesture;
  let values = 0;
  let grows = 0;
  const labels = new Set<ConnectorElementModel>();
  for (const model of written) {
    values += valuesWritten(model, each);
    grows += growthOf(model, each);
    for (const connector of connectorsOf(model.id))
      if (!written.has(connector) && connector.hasLabel())
        labels.add(connector);
  }
  for (const connector of labels) grows += labelGrowth(connector);
  return {
    elements: written.size + labels.size,
    grows,
    values: values + labels.size,
  };
}

/** Whether `writes` is refused: on a full board, when the size and what it
 * keeps for them (`bytesOf`) pass the cap, with the cap's line. The size as
 * it stands is never below the board's (deletions since its last measure
 * leave it high), so a write it fits goes unmeasured: a held arrow key's
 * repeats measure nothing. One that doesn't fit goes once a measure finds
 * room. One element's gesture always goes (a shape's box merges, and a
 * connector's or a rotation's few values are written once, at its end); a
 * board that takes no edits has nothing to refuse. */
export function refusesWrites(store: Store, writes: Writes) {
  if (writes.elements <= 1 || store.readonly || !full.has(store)) return false;
  const fits = () => {
    const size = sizers.get(store)?.size();
    return !size || size.bytes + bytesOf(writes) <= size.max;
  };
  if (fits()) return false;
  checkBoardSize(store);
  if (!full.has(store) || fits()) return false;
  userToast({ title: m.editor_limit_remove_only(), variant: 'warning' });
  return true;
}

/** A drag of a selection (its moving set, known only once the press picked
 * it: a press outside the selection selects what is under it), a resize or a
 * rotation by the selection frame writes each element at its end: on a full
 * board it starts only when `written` (`writesOf`) fits (`refusesWrites`),
 * and refused it moves nothing. BlockSuite's DefaultTool and selection frame
 * call these on the board's one `InteractivityManager`. */
export function gateSelectionWrites(
  store: Store,
  interactivity: Pick<
    InteractivityManager,
    'handleElementMove' | 'handleElementResize' | 'handleElementRotate'
  >,
  written: (models: GfxModel[], gesture: Gesture) => Writes
) {
  const { handleElementMove, handleElementResize, handleElementRotate } =
    interactivity;
  interactivity.handleElementMove = (options) => {
    if (!refusesWrites(store, written(options.movingElements, 'move')))
      handleElementMove.call(interactivity, options);
  };
  interactivity.handleElementResize = (options) => {
    if (!refusesWrites(store, written(options.elements, 'resize')))
      handleElementResize.call(interactivity, options);
  };
  interactivity.handleElementRotate = (options) => {
    if (!refusesWrites(store, written(options.elements, 'rotate')))
      handleElementRotate.call(interactivity, options);
  };
}

const NUDGES = new Set(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
/** A field on the board that takes typed keys: the toolbar's inputs, a
 * colour's, the ☰ menu's, the symbols panel's, an open editor. */
export const TYPING = 'input, textarea, [contenteditable="true"], math-field';

/** An arrow key nudges the selection, writing what it moves (`written`: null
 * when it moves nothing) at every press: on a full board the key is stopped
 * before the board hears it unless that fits (`refusesWrites`). A key typed
 * into a field (`TYPING`) is the field's. Listens on `target` as it
 * captures; returns the stop. */
export function gateNudges(
  target: EventTarget,
  store: Store,
  written: () => Writes | null
) {
  const refuse = (event: Event) => {
    const { altKey, ctrlKey, key, metaKey } = event as KeyboardEvent;
    if (!NUDGES.has(key) || metaKey || ctrlKey || altKey || !full.has(store))
      return;
    const [typed] = event.composedPath() as Partial<Element>[];
    if (typed?.closest?.(TYPING)) return;
    const writes = written();
    if (!(writes && refusesWrites(store, writes))) return;
    event.preventDefault();
    event.stopPropagation();
  };
  target.addEventListener('keydown', refuse, true);
  return () => target.removeEventListener('keydown', refuse, true);
}

/** Whether a change of `props` on `model` places a labelled connector's
 * label again on the new path (vendor/blocksuite local change 63). */
const placesLabel = (model: GfxModel, props: Record<string, unknown>) =>
  model instanceof ConnectorElementModel &&
  model.hasLabel() &&
  ('mode' in props || 'source' in props || 'target' in props);

/** An object or array a block stores as a shared type of its own
 * (`native2Y`: a map, a Y.Array). */
const isShared = (value: unknown): value is object =>
  !!value && typeof value === 'object' && !(value instanceof Uint8Array);

/** The items a block's object or array stored as its own type adds
 * (`native2Y`): a map an item for each value, an array one for each run of
 * plain values (Yjs packs them in one) and each binary, and each map or
 * array inside either one for itself and its own items. */
const itemsOf = (value: object): number => {
  if (!Array.isArray(value))
    return Object.values(value).reduce<number>(
      (sum, entry) => sum + 1 + (isShared(entry) ? itemsOf(entry) : 0),
      0
    );
  let items = 0;
  let packing = false;
  for (const entry of value) {
    if (isShared(entry)) items += 1 + itemsOf(entry);
    else if (entry instanceof Uint8Array || !packing) items += 1;
    packing = !isShared(entry) && !(entry instanceof Uint8Array);
  }
  return items;
};

/** The values a change `props` through the board's `updateElement` writes
 * on `model`: each it names (`NEW_KEY` more for one it stores for the first
 * time; a block's object or array, stored as a type of its own, a new item
 * for each it holds, `itemsOf`: the type it replaces is collected whole), a
 * stroke's width its points and box too (its derive), and a labelled
 * connector's mode or end its label (`placesLabel`). */
export function valuesUpdated(model: GfxModel, props: Record<string, unknown>) {
  let values = 0;
  for (const [key, value] of Object.entries(props)) {
    values += 1;
    if (!storesKey(model, key)) values += NEW_KEY;
    if (!(model instanceof GfxPrimitiveElementModel) && isShared(value))
      values += itemsOf(value);
  }
  if ('lineWidth' in props) values += 2;
  if (placesLabel(model, props)) values += 1;
  return values;
}

/** What a change `props` through the board's `updateElement` grows `model`
 * by: each value it names by its new bytes less those it stores
 * (`anyBytes`, known before the write), a stroke's width its box
 * (`XYWH_LONGEST`), and a labelled connector's mode or end its label's
 * place. */
export function growthUpdated(model: GfxModel, props: Record<string, unknown>) {
  let grows = 0;
  for (const [key, value] of Object.entries(props))
    grows += Math.max(
      0,
      anyBytes(value) -
        (storesKey(model, key) ? anyBytes(stored(model, key)) : 0)
    );
  if ('lineWidth' in props) grows += boxGrowth(model);
  if (placesLabel(model, props))
    grows += labelGrowth(model as ConnectorElementModel);
  return grows;
}

/** The element toolbar's changes (a colour, a stroke, a font, an alignment,
 * a connector's mode or a spread) write every selected element through the
 * board's `updateElement`, one call each in one task: on a full board the
 * first call on what the selection writes (`written`: its elements, null for
 * another element) decides for the task, each element taking what the call
 * names (`valuesUpdated`), so the change goes whole or not at all
 * (`refusesWrites`). */
export function gateElementUpdates(
  store: Store,
  crud: { updateElement: (id: string, props: Record<string, unknown>) => void },
  written: (id: string) => readonly GfxModel[] | null
) {
  const { updateElement } = crud;
  let refused: boolean | null = null;
  crud.updateElement = (id, props) => {
    if (refused === null && full.has(store)) {
      const models = written(id);
      if (models && models.length > 1) {
        let values = 0;
        let grows = 0;
        for (const model of models) {
          values += valuesUpdated(model, props);
          grows += growthUpdated(model, props);
        }
        refused = refusesWrites(store, {
          elements: models.length,
          grows,
          values,
        });
        queueMicrotask(() => {
          refused = null;
        });
      }
    }
    if (!refused) updateElement(id, props);
  };
}

/** The board's commands a full board gates: `adds` add elements (a paste's
 * or Duplicate's copies, a group), `places` place every selected element (an
 * arrange, a resize to one size) and `ungroup` writes the index of each
 * element its group holds directly (an Ungroup, an Unlock of a group). */
export type GatedCommands = {
  adds: unknown[];
  places: unknown[];
  ungroup: unknown;
};

/** What new indexes for `models` write: each one's index, made as `keys`
 * says next to the board's (`indexGrowth`, `longest` the board's longest):
 * a reorder's, an ungroup's for the elements its group holds directly. */
export const orderWrites = (
  models: readonly GfxModel[],
  longest: IndexLengths,
  keys: Keys
): Writes => ({
  elements: models.length,
  grows: indexGrowth(models, longest, keys),
  values: models.length,
});

/** What an ungroup of `group` writes (`ungroupCommand`): the index of each
 * element it holds directly (`split` keys), and, in a group itself, each
 * one's id in that group's children, a new key there (`NEW_KEY`, its `true`
 * a byte), in the same change; the emptied group goes in a change of its
 * own, after. */
export function ungroupWrites(
  group: { childElements: GfxModel[]; group: unknown },
  longest: IndexLengths
): Writes {
  const held = group.childElements;
  const indexes = orderWrites(held, longest, 'split');
  if (!group.group) return indexes;
  return {
    elements: indexes.elements,
    grows: indexes.grows + held.length * anyBytes(true),
    values: indexes.values + held.length * NEW_KEY,
  };
}

/** What an Unlock of several writes: each element's lock (a boolean, as long
 * either way; a mind map's too) and, for a group, what its ungroup writes
 * (`ungroupWrites`), one group after another, so a group's neighbours may be
 * keys the ones before it made. */
export function unlockWrites(
  models: readonly GfxModel[],
  longest: IndexLengths
): Writes {
  let elements = 0;
  let grows = 0;
  let values = 0;
  let reach = longest;
  for (const model of models) {
    if (!(model instanceof GroupElementModel)) {
      elements += 1;
      values += 1;
      continue;
    }
    const ungrouped = ungroupWrites(model, reach);
    elements += ungrouped.elements;
    grows += ungrouped.grows;
    values += ungrouped.values;
    const { length } = model.childElements;
    const made = keyLongest('split', reach, length, length);
    reach = {
      integer: Math.max(reach.integer, made),
      whole: Math.max(reach.whole, made),
    };
  }
  return { elements, grows, values };
}

/** What a node and the nodes under it (`moved`) dropped into another mind
 * map (`into`) write: the map they leave laid out again and restyled at
 * worst, their own restyle among it, the map they join laid out again, and
 * each one's place in the tree it joins, a new key there (`NEW_KEY`; the
 * place itself, a few bytes, is within the Style count each takes). */
export function mergeWrites(
  into: GfxModel,
  moved: GfxModel[],
  written: (models: GfxModel[], gesture: Gesture) => Writes
): Writes {
  const left = written(moved, 'style');
  const joined = written([into], 'layout');
  return {
    elements: left.elements + joined.elements,
    grows: left.grows + joined.grows,
    values: left.values + joined.values + moved.length * NEW_KEY,
  };
}

/** Runs `command`'s gated commands (`commands`) on a full board only as
 * `refusesAdds` and `refusesWrites` allow, what a place writes from
 * `placed`, an ungroup's indexes from the board's `longest`; a refused one
 * runs nothing and answers as a failed command. */
export function gateCommands(
  store: Store,
  command: Pick<CommandManager, 'exec'>,
  commands: GatedCommands,
  placed: () => Writes,
  longest: () => IndexLengths
) {
  const exec = command.exec.bind(command);
  const refuses = (run: unknown, input: unknown) => {
    if (commands.adds.includes(run)) return refusesAdds(store);
    if (commands.places.includes(run)) return refusesWrites(store, placed());
    if (run !== commands.ungroup) return false;
    const { group } = input as {
      group: GfxGroupCompatibleInterface & { group: unknown };
    };
    return refusesWrites(store, ungroupWrites(group, longest()));
  };
  command.exec = ((run, ...rest) =>
    refuses(run, rest[0])
      ? [false, {}]
      : exec(run, ...rest)) as typeof command.exec;
}

/** What the board's toolbar and gestures write straight to models
 * (`boardWrites`, vendor/blocksuite local change 82) asks the board before
 * any write: an add (a Lock of several groups them, a mind map's node
 * dragged off its map makes a new map) is refused as one (`refusesAdds`); a
 * reorder writes each element's index (`orderWrites`, the board's `longest`
 * index: to the front or back `end` keys, a step forward or backward `step`
 * ones), an Unlock each element's lock or a group's elements' indexes (it
 * ungroups, `unlockWrites`); a node merged into another mind map is checked
 * once, at the drop, for both maps (`mergeWrites`); the rest write what
 * `written` counts for their gesture (the alignment menu's `place`, a note's
 * Scale or height, a mind map's Style or Layout). Returns the stop. */
export function gateToolbarWrites(
  store: Store,
  written: (models: GfxModel[], gesture: Gesture) => Writes,
  longest: () => IndexLengths
) {
  boardWrites.gate(store, (models, write) => {
    if (write === 'add') return refusesAdds(store);
    if (write === 'order' || write === 'step')
      return refusesWrites(
        store,
        orderWrites(models, longest(), write === 'order' ? 'end' : 'step')
      );
    if (write === 'unlock')
      return refusesWrites(store, unlockWrites(models, longest()));
    if (write === 'merge') {
      const [into, ...moved] = models;
      return refusesWrites(store, mergeWrites(into, moved, written));
    }
    return refusesWrites(store, written(models, write));
  });
  return () => boardWrites.gate(store, null);
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
