import * as Y from 'yjs';
import {
  type BoardKind,
  blockFits,
  childFits,
  elementFits,
  type Fields,
  holds,
} from './boardRules';

/** Why a saved board doesn't open: it's handed to the page, never half mounted. */
export class BoardLoadError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`drawing board: ${reason}`, options);
    this.name = 'BoardLoadError';
    this.reason = reason;
  }
}

/** The ids a stored map holds under `key` (a group's or mind map's children). */
const keysOf = (map: Y.Map<unknown>, key: string) => {
  const held = map.get(key);
  return held instanceof Y.Map ? [...held.keys()] : [];
};

/** A mind map's nodes against the canvas, which BlockSuite reads without checking:
 * each a shape on the canvas no group or other mind map holds, under a parent among
 * them, one root and no cycle. Its own keys fit already (`elementFits`). */
function mindmapNodesFit(
  id: string,
  mindmap: Y.Map<unknown>,
  canvas: Y.Map<unknown>
) {
  const owned = new Set<string>();
  for (const [other, element] of canvas.entries()) {
    if (other === id || !(element instanceof Y.Map)) continue;
    const type = element.get('type');
    if (type === 'group' || type === 'mindmap')
      for (const node of keysOf(element, 'children')) owned.add(node);
  }
  const children = mindmap.get('children') as Y.Map<Fields>;
  const parentOf = new Map<string, string | undefined>();
  for (const [node, { parent }] of children.entries()) {
    const shape = canvas.get(node);
    if (
      !(shape instanceof Y.Map && shape.get('type') === 'shape') ||
      owned.has(node)
    )
      return false;
    owned.add(node);
    parentOf.set(node, parent as string | undefined);
  }
  let roots = 0;
  for (const parent of parentOf.values()) {
    if (parent === undefined) roots += 1;
    else if (!parentOf.has(parent)) return false;
  }
  if (roots !== 1) return false;
  // From any node, its parents reach the root within as many steps as there are nodes.
  return [...parentOf.keys()].every((node) => {
    let at: string | undefined = node;
    for (let step = 0; at !== undefined; step += 1) {
      if (step > parentOf.size) return false;
      at = parentOf.get(at);
    }
    return true;
  });
}

const FLAVOUR_PREFIX = /^affine:(embed-capy-)?/;
/** The page and the canvas: a board reads them whatever they hold, as without them
 * nothing opens. */
const READ_ALWAYS = new Set(['affine:page', 'affine:surface']);
/** A flavour's short name, for its misfit: `picture` for a capy picture. */
const named = (flavour: string) => flavour.replace(FLAVOUR_PREFIX, '');

/** A saved board's update, checked before anything mounts: one page with one canvas,
 * each block and canvas element as the board's rules take it (boardRules.ts), each
 * block under a parent it may have in one tree, and each mind map's nodes on the
 * canvas. Its blocks and canvas elements as plain data, for the preview.
 *
 * A question's board is its owner's alone, and is refused for the first thing that
 * doesn't fit. A workspace canvas is written by others too, so it opens whenever it
 * has its page and canvas: `misfits` says what doesn't fit, `blocks` and `elements`
 * leave those out, and the board draws them as placeholders (Epo 2026-11-18, delete
 * nothing a person hasn't acknowledged). */
export function checkSavedBoard(update: Uint8Array, board: BoardKind) {
  const { elements: kinds, parents } = holds(board);
  const misfits: string[] = [];
  const misfit = (reason: string) => {
    if (board !== 'workspace') throw new BoardLoadError(reason);
    misfits.push(reason);
  };
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch (cause) {
    throw new BoardLoadError('unreadable', { cause });
  }
  // The blocks of a flavour the board holds, by id.
  const held = new Map<string, Y.Map<unknown>>();
  for (const [id, block] of doc.getMap<unknown>('blocks').entries()) {
    const flavour = block instanceof Y.Map ? block.get('sys:flavour') : null;
    if (typeof flavour === 'string' && parents.has(flavour))
      held.set(id, block as Y.Map<unknown>);
    else misfit(`block ${String(flavour)}`);
  }
  const flavourOf = (id: string) =>
    held.get(id)?.get('sys:flavour') as string | undefined;
  const only = (flavour: string) => {
    const found = [...held.values()].filter(
      (block) => block.get('sys:flavour') === flavour
    );
    return found.length === 1 ? found[0] : null;
  };
  // Without these there is nothing to open, on either board.
  const surface = only('affine:surface');
  if (!only('affine:page') || !surface)
    throw new BoardLoadError('no single page and canvas');
  /** Blocks that don't fit, left out of what is returned (the page and the canvas
   * stay: the board reads them anyway). */
  const out = new Set<string>();
  for (const [id, block] of held) {
    const flavour = flavourOf(id) as string;
    if (blockFits(id, block, board)) continue;
    misfit(`${named(flavour)} fields`);
    if (!READ_ALWAYS.has(flavour)) out.add(id);
  }
  // One tree: every child exists and has one allowed parent, and every block but the
  // page is someone's child.
  const parentOf = new Map<string, string>();
  for (const [id, block] of held) {
    const children = block.get('sys:children');
    if (!(children instanceof Y.Array)) continue;
    for (const child of children.toArray()) {
      if (typeof child !== 'string') continue;
      const below = held.get(child);
      // A child left out for its flavour has been said already.
      if (!below && doc.getMap('blocks').has(child)) continue;
      if (!below || parentOf.has(child) || !childFits(block, below, board)) {
        misfit('block tree');
        if (below) out.add(child);
      } else parentOf.set(child, id);
    }
  }
  for (const id of held.keys())
    if (
      !out.has(id) &&
      (flavourOf(id) === 'affine:page') === parentOf.has(id)
    ) {
      misfit('block tree');
      out.add(id);
    }
  // A canvas whose holder doesn't fit was said above; its elements are read when
  // they are there to read.
  const holder = surface.get('prop:elements');
  const value = holder instanceof Y.Map ? holder.get('value') : null;
  const canvas = value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
  const elements: Record<string, Fields> = {};
  if (canvas)
    for (const [id, element] of canvas.entries()) {
      const type = element instanceof Y.Map ? element.get('type') : undefined;
      if (!(element instanceof Y.Map && elementFits(id, element, board))) {
        misfit(
          kinds.has(type as string)
            ? `${String(type)} fields`
            : `element type ${String(type)}`
        );
        continue;
      }
      if (type === 'mindmap' && !mindmapNodesFit(id, element, canvas)) {
        misfit('mindmap nodes');
        continue;
      }
      elements[id] = element.toJSON() as Fields;
    }
  const blocks = Object.fromEntries(
    [...held]
      .filter(([id]) => !out.has(id))
      .map(([id, block]) => [id, block.toJSON() as Fields])
  );
  doc.destroy();
  return { blocks, elements, misfits };
}

/** A stored canvas element read from its own map (`id` is its key), as the load check
 * would take it: the board draws it for real, and anything else as a placeholder. A
 * mind map's nodes are checked against the canvas it is on. */
export function storedElementFits(
  id: string,
  element: Y.Map<unknown>,
  board: BoardKind
) {
  if (!elementFits(id, element, board)) return false;
  return (
    element.get('type') !== 'mindmap' ||
    mindmapNodesFit(id, element, element.parent as Y.Map<unknown>)
  );
}

/** A stored block read from its own map, as the load check would take it one block
 * at a time (its place in the tree isn't read). Its id is its key in the blocks.
 * The page and the canvas are read whatever they hold. */
export function storedBlockFits(block: Y.Map<unknown>, board: BoardKind) {
  if (READ_ALWAYS.has(block.get('sys:flavour') as string)) return true;
  const id = block._item?.parentSub;
  return typeof id === 'string' && blockFits(id, block, board);
}
