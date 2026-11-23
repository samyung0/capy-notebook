import { setFigureCodec } from '@slate-yjs/core';
import {
  type FigureBlock,
  type FigureType,
  heldBlock,
  isFigureType,
  newFigureMap,
  writeFigure,
} from '@/features/figures/figureMap';

/* A note figure's `block` through the slate-yjs patch (Epo 2026-11-16, D15):
 * the room holds the figure map a quiz room holds (figures/figureMap.ts) and
 * Slate the plain block. A remote change reads the map as held (editors show
 * a merge's issues), a local `set_node` of the block writes only what differs
 * (each change of the live figure dialog, a plot's Save), and an insert or a
 * clone builds a new map.
 * Imported, for its registration, wherever slate-yjs meets a note room. */

function figureType(type: string): FigureType {
  if (!isFigureType(type)) throw new Error(`${type} is not a figure`);
  return type;
}

/** The block a figure element of `type` writes: its own type must match. */
function blockOf(type: string, block: Record<string, unknown>): FigureBlock {
  if (block.type !== figureType(type))
    throw new Error(`A ${type} cannot hold a ${String(block.type)} block`);
  return block as FigureBlock;
}

setFigureCodec({
  create: (type, block) => newFigureMap(blockOf(type, block)),
  // The editor edits the block as held, every entry, so a removal of any
  // goes (a pie's extra series, a graph row naming a gone point).
  edit: (type, map, block) =>
    writeFigure(map, blockOf(type, block), heldBlock(map, figureType(type))),
  read: (type, map) => heldBlock(map, figureType(type)),
});
