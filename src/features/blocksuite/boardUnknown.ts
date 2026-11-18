import {
  ElementReadableIdentifier,
  GfxCompatible,
  type GfxCompatibleProps,
} from '@blocksuite/affine/std/gfx';
import {
  BlockModel,
  BlockSchemaExtension,
  BlockStandInExtension,
  defineBlockSchema,
  type ExtensionType,
} from '@blocksuite/affine/store';
import type * as Y from 'yjs';
import {
  type BoardKind,
  holds,
  isPlace,
  storedBlockFits,
  storedElementFits,
} from './boardLoad';

/* What a board can't read (a peer's or a newer version's block or canvas element, one
 * past a limit) is never refused or taken out: it stays in the document as it is and
 * is drawn as a placeholder, "This block cannot be shown" (Epo 2026-11-18, mock A).
 * This is the store's side, which decides what is read; `boardUnknownView.ts` draws
 * it. A canvas element's placeholder is BlockSuite's own model (vendor local change
 * 62); a block's is one of the two below. */

/** A block the board can't read, where it sits in a note's text. */
export const UNKNOWN_BLOCK = 'capy:unknown';
/** One with a place of its own on the canvas. */
export const UNKNOWN_CARD = 'capy:unknown-card';

// Neither declares props, so reading a block through them writes nothing to it.
const UnknownBlockSchema = defineBlockSchema({
  flavour: UNKNOWN_BLOCK,
  metadata: { role: 'content', version: 1 },
});

export class UnknownCardModel extends GfxCompatible<GfxCompatibleProps>(
  BlockModel
) {
  /** No floating toolbar, as BlockSuite's own placeholder (vendor local change 62). */
  readonly toolbar = false;
}

const UnknownCardSchema = defineBlockSchema({
  flavour: UNKNOWN_CARD,
  metadata: { role: 'content', version: 1 },
  toModel: () => new UnknownCardModel(),
});

/** Whether a stored block has what the canvas needs to draw a card for it: a place,
 * an order, and a turn it can read when it has one. */
function hasPlace(block: Y.Map<unknown>) {
  const rotate = block.get('prop:rotate');
  return (
    isPlace(block.get('prop:xywh')) &&
    typeof block.get('prop:index') === 'string' &&
    (rotate === undefined ||
      (typeof rotate === 'number' && Number.isFinite(rotate)))
  );
}

/** A board's store extensions for what it can't read: a stored block or element that
 * doesn't fit the board's catalog is read as a placeholder. */
export function unknownStore(board: BoardKind): ExtensionType[] {
  const { elements, parents } = holds(board);
  return [
    BlockSchemaExtension(UnknownBlockSchema),
    BlockSchemaExtension(UnknownCardSchema),
    BlockStandInExtension((block, known) => {
      if (known && storedBlockFits(block, parents)) return known;
      return hasPlace(block) ? UnknownCardSchema : UnknownBlockSchema;
    }),
    {
      setup: (di) => {
        di.addImpl(
          ElementReadableIdentifier,
          () => (id: string, element: Y.Map<unknown>) =>
            storedElementFits(id, element, elements)
        );
      },
    },
  ];
}
