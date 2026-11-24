import type { SurfaceBlockModel } from '@blocksuite/affine/std/gfx';
import type { Store } from '@blocksuite/affine/store';
import * as Y from 'yjs';
import { storedElementFits } from './boardLoad';
import { type BoardKind, holds, isPlace } from './boardRules';
import { isStrokePoints, strokeView } from './strokePoints';

/** Whether a change is this tab's own person's doing: made here, and not by an undo
 * or redo, which brings back what was there. An update applied from elsewhere (the
 * loaded board, a peer's through the room) is not: Yjs marks it as not local, and
 * the room applies it under an origin of its own. BlockSuite writes under the
 * document's client id, under none (`withoutTransact`), or under its props' proxy. */
function ownAction({ doc, local, origin }: Y.Transaction) {
  return (
    local &&
    (origin === null ||
      origin === doc.clientID ||
      (origin as { proxy?: boolean } | undefined)?.proxy === true)
  );
}

/** A board holds only what its load check would take (Epo 2026-11-09): a mind map
 * goes with its node shapes.
 *
 * A question's board checks whatever adds something (a paste, a duplicate), and takes
 * out what doesn't fit. A workspace canvas does so only for what its own person adds
 * here: what a peer or a newer version added stays in the document and is drawn as a
 * placeholder, since only its own person may remove it (Epo 2026-11-18). */
export function keepToCatalog(
  store: Store,
  surface: SurfaceBlockModel | null,
  board: BoardKind
) {
  const { parents } = holds(board);
  const refuses = (transaction: Y.Transaction) =>
    board !== 'workspace' || ownAction(transaction);
  const canvas = surface?.elements.getValue();
  // Checked once the add's transaction is done: a mind map gets its nodes after itself.
  const checkElement = (id: string) => {
    const element = canvas?.get(id);
    if (!(surface && canvas && element)) return;
    if (element instanceof Y.Map && storedElementFits(id, element, board))
      return;
    // One the canvas gave no model (it has no place to draw at) goes from the map.
    if (surface.hasElementById(id)) surface.deleteElement(id);
    else store.transact(() => canvas.delete(id));
  };
  const checkBlock = (id: string) => {
    const block = store.getBlock(id);
    if (block && !parents.has(block.flavour)) store.deleteBlock(block.model);
  };
  const watch =
    (check: (id: string) => void) =>
    (event: Y.YMapEvent<Y.Map<unknown>>, transaction: Y.Transaction) => {
      if (!refuses(transaction)) return;
      for (const [id, change] of event.changes.keys)
        if (change.action === 'add') queueMicrotask(() => check(id));
    };
  const onElements = watch(checkElement);
  const onBlocks = watch(checkBlock);
  const blocks = store.spaceDoc.getMap<Y.Map<unknown>>('blocks');
  canvas?.observe(onElements);
  blocks.observe(onBlocks);
  return () => {
    canvas?.unobserve(onElements);
    blocks.unobserve(onBlocks);
  };
}

const roundPlace = (xywh: string) =>
  JSON.stringify(
    (JSON.parse(xywh) as number[]).map((value) => Math.round(value * 10) / 10)
  );

/** The saved copy keeps strokes to whole pixels and places to a tenth, with no change
 * to see (drawing answers' measure, 2026-11-06, for Epo's "every stored byte cut"):
 * a place's text gets shorter, and a stroke's Float32s, the same size either way,
 * gzip to 40% as the bucket keeps them (2026-11-24). Pressure stays, as
 * perfect-freehand draws the line from it.
 * Only what the board holds is rounded: a block or element it doesn't know is copied
 * as it is. */
function roundPlaces(doc: Y.Doc, board: BoardKind) {
  const { elements: kinds, parents } = holds(board);
  const place = (map: Y.Map<unknown>, key: string) => {
    const xywh = map.get(key);
    if (!isPlace(xywh)) return;
    const rounded = roundPlace(xywh as string);
    if (rounded !== xywh) map.set(key, rounded);
  };
  doc.transact(() => {
    for (const block of doc.getMap<unknown>('blocks').values()) {
      if (!(block instanceof Y.Map)) continue;
      if (!parents.has(block.get('sys:flavour') as string)) continue;
      place(block, 'prop:xywh');
      const native: unknown = block.get('prop:elements');
      const canvas = native instanceof Y.Map ? native.get('value') : null;
      if (!(canvas instanceof Y.Map)) continue;
      for (const element of canvas.values()) {
        if (!(element instanceof Y.Map)) continue;
        const type = element.get('type') as string;
        if (!kinds.has(type)) continue;
        place(element, 'xywh');
        if (type !== 'brush' && type !== 'highlighter') continue;
        const points = element.get('points');
        // A stroke a peer wrote another way is copied as it is.
        if (!isStrokePoints(points)) continue;
        // A copy starts on its own buffer, so its view writes in place.
        const rounded = points.slice();
        const { stride, values } = strokeView(rounded);
        for (let i = 0; i < values.length; i += stride) {
          values[i] = Math.round(values[i]);
          values[i + 1] = Math.round(values[i + 1]);
        }
        element.set('points', rounded);
      }
    }
  });
}

/** The board to store, with no undo history: a fresh document keeps only what's on
 * the board (200 plane clicks were 606 KB live, 7.5 KB this way), rounded
 * (roundPlaces). */
export function savedCopy(live: Y.Doc, board: BoardKind) {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(live));
  roundPlaces(fresh, board);
  const update = Y.encodeStateAsUpdate(fresh);
  fresh.destroy();
  return update;
}
