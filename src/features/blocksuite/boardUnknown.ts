import {
  ElementReadableIdentifier,
  GfxCompatible,
  type GfxCompatibleProps,
} from '@blocksuite/affine/std/gfx';
import {
  BlockModel,
  BlockSchemaExtension,
  type BlockSnapshot,
  BlockStandInExtension,
  defineBlockSchema,
  type ExtensionType,
  type TransformerMiddleware,
} from '@blocksuite/affine/store';
import type * as Y from 'yjs';
import { storedBlockFits, storedElementFits } from './boardLoad';
import { type BoardKind, isPlace } from './boardRules';

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
  return [
    BlockSchemaExtension(UnknownBlockSchema),
    BlockSchemaExtension(UnknownCardSchema),
    BlockStandInExtension((block, known) => {
      if (known && storedBlockFits(block, board)) return known;
      return hasPlace(block) ? UnknownCardSchema : UnknownBlockSchema;
    }),
    {
      setup: (di) => {
        di.addImpl(
          ElementReadableIdentifier,
          () => (id: string, element: Y.Map<unknown>) =>
            storedElementFits(id, element, board)
        );
      },
    },
  ];
}

const PLACEHOLDERS = new Set([UNKNOWN_BLOCK, UNKNOWN_CARD]);

/** Blocks without the placeholders among them or anywhere below. */
function withoutPlaceholders(blocks: BlockSnapshot[]): BlockSnapshot[] {
  const kept = blocks.filter(({ flavour }) => !PLACEHOLDERS.has(flavour));
  for (const block of kept)
    block.children = withoutPlaceholders(block.children);
  return kept;
}

/** The clipboard's middleware that keeps a block's placeholder out of copies: what
 * it stands for is another build's or person's, which this board never writes (a
 * paste of one would reach the room and every peer before `keepToCatalog` took it
 * out again). It leaves them out of what a copy
 * in a note's text exports, and out of whatever a paste or Duplicate puts down (the
 * canvas's own copy serializes without the clipboard's middlewares). An element's
 * placeholder the canvas's copy leaves out itself (vendor local change 74). */
export const placeholdersLeftOut: TransformerMiddleware = ({ slots }) => {
  const exported = slots.afterExport.subscribe((payload) => {
    if (payload.type === 'slice')
      payload.snapshot.content = withoutPlaceholders(payload.snapshot.content);
  });
  const imported = slots.beforeImport.subscribe((payload) => {
    // A slice's whole tree: a pasted note's children may become its blocks.
    if (payload.type === 'slice')
      payload.snapshot.content = withoutPlaceholders(payload.snapshot.content);
    // Each block of a tree gets its own call, its children after it.
    else if (payload.type === 'block')
      payload.snapshot.children = payload.snapshot.children.filter(
        ({ flavour }) => !PLACEHOLDERS.has(flavour)
      );
  });
  return () => {
    exported.unsubscribe();
    imported.unsubscribe();
  };
};
