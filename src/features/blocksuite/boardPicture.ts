import { StoreExtensionProvider } from '@blocksuite/affine/ext-loader';
import type { Bound } from '@blocksuite/affine/global/gfx';
import {
  BlockViewExtension,
  FlavourExtension,
  GfxBlockComponent,
} from '@blocksuite/affine/std';
import {
  type GfxCommonBlockProps,
  GfxCompatible,
  type GfxController,
  GfxViewInteractionExtension,
} from '@blocksuite/affine/std/gfx';
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type ExtensionType,
} from '@blocksuite/affine/store';
import { css, html } from 'lit';
import { literal } from 'lit/static-html.js';
import { emojiUrl, isKlipyMedia, type PictureKind } from './boardPictureData';

type PictureProps = {
  kind: PictureKind;
  /** The emoji's code point(s), or the KLIPY media URL. */
  ref: string;
  label: string;
  rotate: number;
} & Omit<GfxCommonBlockProps, 'scale'>;

export const PICTURE_FLAVOUR = 'affine:embed-capy-picture';

export const PictureBlockSchema = defineBlockSchema({
  flavour: PICTURE_FLAVOUR,
  metadata: {
    children: [],
    parent: ['affine:surface'],
    role: 'content',
    version: 1,
  },
  props: (): PictureProps => ({
    index: 'a0',
    kind: 'emoji',
    label: '',
    lockedBySelf: false,
    ref: '',
    rotate: 0,
    xywh: '[0,0,0,0]',
  }),
  toModel: () => new PictureBlockModel(),
});

export class PictureBlockModel extends GfxCompatible<PictureProps>(
  BlockModel
) {}

class PictureBlockComponent extends GfxBlockComponent<PictureBlockModel> {
  static override styles = css`
    capy-picture {
      display: block;
    }
    capy-picture img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
      user-select: none;
    }
  `;

  override renderGfxBlock() {
    const { kind, label, ref, rotate } = this.model.props;
    const src = kind === 'emoji' ? emojiUrl(ref) : isKlipyMedia(ref) ? ref : '';
    return html`<img
      alt=${label}
      draggable="false"
      referrerpolicy="no-referrer"
      src=${src}
      style="transform:rotate(${rotate}deg)"
    />`;
  }
}

if (!customElements.get('capy-picture'))
  customElements.define('capy-picture', PictureBlockComponent);

/** Its schema, for every board's store: a board that may not hold one refuses it on
 * load (board catalog). */
export class PictureStoreExtension extends StoreExtensionProvider {
  override name = 'capy-picture';

  override setup(context: Parameters<StoreExtensionProvider['setup']>[0]) {
    super.setup(context);
    context.register(BlockSchemaExtension(PictureBlockSchema));
  }
}

export const pictureViews: ExtensionType[] = [
  FlavourExtension(PICTURE_FLAVOUR),
  BlockViewExtension(PICTURE_FLAVOUR, literal`capy-picture`),
  GfxViewInteractionExtension(PICTURE_FLAVOUR, {
    resizeConstraint: { lockRatio: true },
  }),
];

/** Puts a picture down, centred on a box's middle at its size. */
export function addPicture(
  gfx: GfxController,
  box: Bound,
  picture: { kind: PictureKind; label: string; ref: string }
) {
  const surface = gfx.surface;
  if (!surface) return;
  gfx.doc.captureSync();
  const id = gfx.doc.addBlock(
    PICTURE_FLAVOUR,
    { ...picture, xywh: box.serialize() },
    surface.id
  );
  gfx.selection.set({ editing: false, elements: [id] });
  return id;
}
