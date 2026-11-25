import type {
  BrushElementModel,
  HighlighterElementModel,
} from '@blocksuite/affine-model';
import {
  type GfxElementModelView,
  GfxViewInteractionExtension,
} from '@blocksuite/std/gfx';

/* Capy (vendor/blocksuite/README.md, local change 81): a stroke resized keeps
 * its points this tab's until the resize ends, as its box is, then each is
 * written once. Its box's derive rewrites the points (`brush.ts`,
 * `highlighter.ts`), and upstream stashed only the box, so a resize stored
 * the points on every frame. */
const resizesWithPoints = (type: 'brush' | 'highlighter') =>
  GfxViewInteractionExtension<
    GfxElementModelView<BrushElementModel | HighlighterElementModel>
  >(type, {
    handleResize: ({ model }) => ({
      onResizeStart() {
        model.stash('xywh');
        model.stash('points');
      },
      onResizeEnd() {
        model.pop('xywh');
        model.pop('points');
      },
    }),
  });

export const BrushInteraction = resizesWithPoints('brush');
export const HighlighterInteraction = resizesWithPoints('highlighter');
