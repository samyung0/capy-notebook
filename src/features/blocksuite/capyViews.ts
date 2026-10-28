import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine/ext-loader';
import { BlockComponent, BlockViewExtension } from '@blocksuite/affine/std';
import { html } from 'lit';
import { literal } from 'lit/static-html.js';
import { CAPY_FLAVOURS, type CapyBlockModel } from './capyBlocks';

/* Views of our flavours: for now a read-only placeholder naming the block
 * type, and the blocks a column holds (`capy:material-ref` gets its own in
 * piece 4). */

const PLACEHOLDER = 'capy-placeholder-block';

/** A capy block's stand-in: its type, and the blocks it holds. */
class PlaceholderBlock extends BlockComponent<CapyBlockModel> {
  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = 'false';
  }

  override renderBlock() {
    return html`<div
      data-capy-placeholder=${this.model.flavour}
      style="margin: 8px 0; padding: 8px 12px; border: 1px dashed var(--affine-border-color); border-radius: 6px; color: var(--affine-text-secondary-color); font-size: 13px;"
    >
      ${this.model.flavour}
      <div contenteditable="true">${this.renderChildren(this.model)}</div>
    </div>`;
  }
}

export class CapyViewExtension extends ViewExtensionProvider {
  override name = 'capy-blocks';

  override effect() {
    super.effect();
    if (!customElements.get(PLACEHOLDER))
      customElements.define(PLACEHOLDER, PlaceholderBlock);
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(
      Object.keys(CAPY_FLAVOURS).map((flavour) =>
        BlockViewExtension(flavour, literal`capy-placeholder-block`)
      )
    );
  }
}
