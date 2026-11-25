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
 * and deleted mark) for every value overwritten. Back-to-back overwrites of
 * one value by one tab merge (1,000 drags of one shape add 35 B), but not
 * where values alternate: a gesture on several elements interleaves their
 * writes, and one element's gesture writing two or more values (a
 * connector's ends and label, a rotation's angle and place, a text label's
 * box and font size) interleaves its own. Those never merge: a select-all
 * drag adds about 10 B an element, and no fold collects them. 16 B is the
 * margin over that measure. */
export const BOARD_WRITE_BYTES = 16;

/** What a write reaches: its elements, and the values it writes on them. */
export type Writes = { elements: number; values: number };

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

/** What a resize writes on an element besides its box: a text label its
 * font size (a corner) or wrap (a side), a note its scale, a stroke its
 * points (vendor/blocksuite local change 81), a plane its view's corner. */
const RESIZED: Record<string, number> = {
  'affine:note': 2,
  brush: 2,
  highlighter: 2,
  plane: 3,
  text: 2,
};

/** What a mind map's Style writes on each node: up to ten of its values (its
 * colours, font, padding, radius and shadow) and its box once, measured at
 * 216 B a node at most over every change of style (Yjs keeps each colour and
 * the shadow as a new object): 14 values' worth (`BOARD_WRITE_BYTES`). Its
 * Layout writes each node's box and a first-level node's place in the tree,
 * measured at 18 B a node at most: 2. */
const NODE_STYLED = 14;
const NODE_LAID_OUT = 2;

/** The values `gesture` writes on `model`, at most: a group's box is its
 * elements' and writes nothing; a mind map's tree takes a dragged node's new
 * place, its style or its layout; a mind map's node its style
 * (`NODE_STYLED`) or its place when its map is restyled or laid out again
 * (`NODE_LAID_OUT`); a connector writes its free ends and its label
 * (`moveTo`, its resize and rotation); a rotation an angle and a place; a
 * note placed its collapse and collapsed height too (`updateXYWH`), scaled
 * its scale, its height set its collapse. A note showing a size it measured
 * stores it first (vendor/blocksuite local change 75): one more. */
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
  if (gesture === 'resize') return (RESIZED[kind] ?? 1) + shown;
  if (gesture === 'place' && kind === 'affine:note') return 3 + shown;
  if (gesture === 'scale' || gesture === 'height') return 2 + shown;
  return 1 + shown;
}

/** What `gesture` on `models` writes (`elementsWritten`, `valuesWritten`),
 * with the label of each labelled connector hanging on one of them
 * (`connectorsOf`), which the tab moving its end places (vendor/blocksuite
 * local change 63). */
export function writesOf(
  models: Iterable<GfxModel>,
  gesture: Gesture,
  connectorsOf: (id: string) => Iterable<ConnectorElementModel>
): Writes {
  const written = elementsWritten(models);
  let values = 0;
  const labels = new Set<ConnectorElementModel>();
  for (const model of written) {
    values += valuesWritten(model, gesture);
    for (const connector of connectorsOf(model.id))
      if (!written.has(connector) && connector.hasLabel())
        labels.add(connector);
  }
  return { elements: written.size + labels.size, values: values + labels.size };
}

/** Whether `writes` is refused: on a full board, when the size and
 * `BOARD_WRITE_BYTES` a value pass the cap, with the cap's line. The size as
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
    return !size || size.bytes + BOARD_WRITE_BYTES * writes.values <= size.max;
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

/** The values a change `props` through the board's `updateElement` writes
 * on `model`: each it names, a stroke's width its points and box too (its
 * derive), and a labelled connector's mode or end its label, placed again
 * on the new path (vendor/blocksuite local change 63). */
export function valuesUpdated(model: GfxModel, props: Record<string, unknown>) {
  let values = Object.keys(props).length;
  if ('lineWidth' in props) values += 2;
  if (
    model instanceof ConnectorElementModel &&
    model.hasLabel() &&
    ('mode' in props || 'source' in props || 'target' in props)
  )
    values += 1;
  return values;
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
        const values = models.reduce(
          (sum, model) => sum + valuesUpdated(model, props),
          0
        );
        refused = refusesWrites(store, { elements: models.length, values });
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

/** Runs `command`'s gated commands (`commands`) on a full board only as
 * `refusesAdds` and `refusesWrites` allow, what a place writes from
 * `placed`; a refused one runs nothing and answers as a failed command. */
export function gateCommands(
  store: Store,
  command: Pick<CommandManager, 'exec'>,
  commands: GatedCommands,
  placed: () => Writes
) {
  const exec = command.exec.bind(command);
  const refuses = (run: unknown, input: unknown) => {
    if (commands.adds.includes(run)) return refusesAdds(store);
    if (commands.places.includes(run)) return refusesWrites(store, placed());
    if (run !== commands.ungroup) return false;
    const { length } = (input as { group: GfxGroupCompatibleInterface }).group
      .childElements;
    return refusesWrites(store, { elements: length, values: length });
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
 * reorder writes each element's index, an Unlock each element's lock or a
 * group's elements' (it ungroups); a node merged into another mind map takes
 * its style (`NODE_STYLED` a node) and lays that map out again; the rest
 * write what `written` counts for their gesture (the alignment menu's
 * `place`, a note's Scale or height, a mind map's Style or Layout). Returns
 * the stop. */
export function gateToolbarWrites(
  store: Store,
  written: (models: GfxModel[], gesture: Gesture) => Writes
) {
  boardWrites.gate(store, (models, write) => {
    if (write === 'add') return refusesAdds(store);
    if (write === 'order')
      return refusesWrites(store, {
        elements: models.length,
        values: models.length,
      });
    if (write === 'unlock') {
      const each = models.map((model) =>
        model instanceof GroupElementModel ? model.childElements.length : 1
      );
      const length = each.reduce((sum, n) => sum + n, 0);
      return refusesWrites(store, { elements: length, values: length });
    }
    if (write === 'merge') {
      const [into, ...moved] = models;
      const laidOut = written([into], 'layout');
      return refusesWrites(store, {
        elements: laidOut.elements + moved.length,
        values: laidOut.values + moved.length * NODE_STYLED,
      });
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
