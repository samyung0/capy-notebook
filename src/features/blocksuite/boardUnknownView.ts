import {
  type ElementRenderer,
  ElementRendererExtension,
} from '@blocksuite/affine/blocks/surface';
import {
  BlockComponent,
  BlockViewExtension,
  FlavourExtension,
  GfxBlockComponent,
} from '@blocksuite/affine/std';
import {
  type GfxViewInteractionConfig,
  GfxViewInteractionExtension,
  UNKNOWN_ELEMENT_TYPE,
  type UnknownElementModel,
} from '@blocksuite/affine/std/gfx';
import type { BlockModel, ExtensionType } from '@blocksuite/affine/store';
import { html, nothing } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { literal } from 'lit/static-html.js';
import { m } from '@/i18n';
import { UNKNOWN_BLOCK, UNKNOWN_CARD, UnknownCardModel } from './boardUnknown';

/* The placeholder a board draws for what it can't read (Epo 2026-11-18, mock A): the
 * notes' notice in a dashed outline at the element's own place and size, or the
 * notice alone where the block sits in a note's text. Its look is in
 * drawingBoard.css (`.capy-unknown-card`, `.capy-unknown-line`); the canvas element
 * is painted to match. It is picked, moved and sized as anything on the board is;
 * nothing opens it, and it has no toolbar. */

/** Whether a block sits on the canvas itself (under the page or its surface, as the
 * canvas reads it) and not in a note's text. */
const onCanvas = ({ parent }: BlockModel) =>
  parent?.role === 'root' || parent?.flavour === 'affine:surface';

/** A block in a note's text. On the canvas it has no place to draw at, and draws
 * nothing. */
class UnknownBlockComponent extends BlockComponent {
  override renderBlock() {
    if (!this.model.parent || onCanvas(this.model)) return nothing;
    return html`<div class="capy-unknown-line" contenteditable="false">
      ${m.material_unsupported_block()}
    </div>`;
  }
}

/** A block with a place of its own on the canvas. */
class UnknownCardComponent extends GfxBlockComponent<UnknownCardModel> {
  override renderGfxBlock() {
    return html`<div
      class="capy-unknown-card"
      style=${styleMap({ transform: `rotate(${this.model.rotate}deg)` })}
    >
      ${m.material_unsupported_block()}
    </div>`;
  }
}

if (!customElements.get('capy-unknown-block'))
  customElements.define('capy-unknown-block', UnknownBlockComponent);
if (!customElements.get('capy-unknown-card'))
  customElements.define('capy-unknown-card', UnknownCardComponent);

/** Where a line may break: after a space, and between CJK characters. */
const WORDS = /[　-鿿＀-￯]|[^\s　-鿿＀-￯]+\s*/g;

/** The notice's lines within `width`, as the card's CSS wraps them. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.match(WORDS) ?? []) {
    if (line && ctx.measureText((line + word).trimEnd()).width > width) {
      lines.push(line.trimEnd());
      line = word;
    } else line += word;
  }
  return line ? [...lines, line.trimEnd()] : lines;
}

/** `.capy-unknown-card` on the canvas: its sizes are that rule's, its colours and
 * font the board's own, read where the canvas sits. */
const unknownRenderer: ElementRenderer<UnknownElementModel> = (
  model,
  ctx,
  matrix,
  renderer
) => {
  const [, , w, h] = model.deserializedXYWH;
  ctx.setTransform(
    matrix
      .translateSelf(w / 2, h / 2)
      .rotateSelf(model.rotate)
      .translateSelf(-w / 2, -h / 2)
  );
  const style = getComputedStyle(renderer.canvas);
  // A 1px border drawn inside the box, as CSS draws one.
  ctx.strokeStyle = style.getPropertyValue('--capy-unknown-edge');
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, w - 1, h - 1, 5.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `${style.fontWeight} 14px ${style.fontFamily}`;
  ctx.fillStyle = style.getPropertyValue('--text-muted');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 16px of padding inside the border on each side, lines 21px apart.
  const lines = wrap(ctx, m.material_unsupported_block(), w - 34);
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 21);
  });
};

/** The mock's frame: a square on each corner, which sizes it in its own shape, and
 * no knob to turn it. */
const frame: GfxViewInteractionConfig = {
  handleRotate: () => ({
    beforeRotate: (context) => context.set({ rotatable: false }),
  }),
  resizeConstraint: {
    allowedHandlers: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    lockRatio: true,
  },
};

export const unknownViews: ExtensionType[] = [
  FlavourExtension(UNKNOWN_BLOCK),
  FlavourExtension(UNKNOWN_CARD),
  BlockViewExtension(UNKNOWN_BLOCK, literal`capy-unknown-block`),
  // A block with a place that sits in a note's text is drawn there, as a line.
  BlockViewExtension(UNKNOWN_CARD, (model) =>
    model instanceof UnknownCardModel && onCanvas(model)
      ? literal`capy-unknown-card`
      : literal`capy-unknown-block`
  ),
  GfxViewInteractionExtension(UNKNOWN_CARD, frame),
  ElementRendererExtension(UNKNOWN_ELEMENT_TYPE, unknownRenderer),
  GfxViewInteractionExtension(UNKNOWN_ELEMENT_TYPE, frame),
];
