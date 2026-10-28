import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine/ext-loader';
import { createIdentifier } from '@blocksuite/affine/global/di';
import { BlockComponent, BlockViewExtension } from '@blocksuite/affine/std';
import type { ExtensionType } from '@blocksuite/affine/store';
import { html } from 'lit';
import { literal } from 'lit/static-html.js';
import type { MaterialRefKind } from '@/features/materials/document';
import type { BlockIslands } from '@/features/notes/blocksuite/islands';
import { CAPY_FLAVOURS, type CapyBlockModel } from './capyBlocks';

/* Views of our flavours: `capy:material-ref` holds a React island, the rest
 * are for now a read-only placeholder naming the block type, and the blocks
 * a column holds. */

const PLACEHOLDER = 'capy-placeholder-block';
const MATERIAL_REF = 'capy-material-ref-block';

/** The note's islands (islands.ts), one per mounted editor. */
export const BlockIslandsIdentifier =
  createIdentifier<BlockIslands>('capy-block-islands');

export const blockIslandsExtension = (
  islands: BlockIslands
): ExtensionType => ({
  setup: (di) => {
    di.addImpl(BlockIslandsIdentifier, () => islands);
  },
});

/** What the island's own controls handle, kept from BlockSuite: its
 * keyboard listens on the document and its pointer and clipboard handlers
 * on the host, so a key pressed on a quiz's button would otherwise also edit
 * the note. React still gets them: a portal listens on its container, this
 * same element, and stopPropagation spares its other listeners. */
const ISLAND_EVENTS = [
  'beforeinput',
  'click',
  'compositionend',
  'compositionstart',
  'compositionupdate',
  'copy',
  'cut',
  'dblclick',
  'input',
  'keydown',
  'keyup',
  'paste',
  'pointerdown',
  'pointerup',
] as const;

const stop = (event: Event) => event.stopPropagation();

/**
 * The embedded quiz or flashcard set (piece 4): a void block whose element
 * the note's React tree renders the app's embed into, reading the item's own
 * rooms. It sits only at the top level of the note (layout spec).
 */
class MaterialRefBlock extends BlockComponent<CapyBlockModel> {
  private readonly island = document.createElement('div');
  private islands: BlockIslands | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = 'false';
    for (const type of ISLAND_EVENTS)
      this.disposables.addFromEvent(this.island, type, stop);
    this.islands = this.std.get(BlockIslandsIdentifier);
    this.publish();
    // The service repoints a pasted block to the note's own copy.
    this.disposables.add(
      this.model.propsUpdated.subscribe(() => this.publish())
    );
  }

  override disconnectedCallback() {
    this.islands?.delete(this.model.id, this.island);
    super.disconnectedCallback();
  }

  private publish() {
    const { model } = this;
    this.islands?.set({
      element: this.island,
      id: model.id,
      materialId: String(model.props.materialId ?? ''),
      refKind: model.props.refKind as MaterialRefKind,
      remove: () => {
        if (this.store.hasBlock(model.id)) this.store.deleteBlock(model);
      },
    });
  }

  override renderBlock() {
    return html`<div data-capy-material-ref style="margin: 16px 0;">
      ${this.island}
    </div>`;
  }
}

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
    if (!customElements.get(MATERIAL_REF))
      customElements.define(MATERIAL_REF, MaterialRefBlock);
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(
      Object.keys(CAPY_FLAVOURS).map((flavour) =>
        BlockViewExtension(
          flavour,
          flavour === 'capy:material-ref'
            ? literal`capy-material-ref-block`
            : literal`capy-placeholder-block`
        )
      )
    );
  }
}
