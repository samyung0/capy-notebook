import { StoreExtensionProvider } from '@blocksuite/affine/ext-loader';
import { Bound } from '@blocksuite/affine/global/gfx';
import {
  type BlockStdScope,
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
import { css, html, nothing } from 'lit';
import { literal } from 'lit/static-html.js';
import { youtubeWatchUrl } from '@/features/materials/youtubeUrl';
import { m } from '@/i18n';

/** Cards on the workspace canvas (Epo 2026-11-09): a link (a YouTube video shows its
 * poster) and a quiz or flashcard set from the workspace. Both open on a double
 * click, a link in a new tab and a material in the workspace. */

type Common = { rotate: number } & Omit<GfxCommonBlockProps, 'scale'>;
const common = (): Common => ({
  index: 'a0',
  lockedBySelf: false,
  rotate: 0,
  xywh: '[0,0,0,0]',
});
const onSurface = {
  children: [],
  parent: ['affine:surface'],
  role: 'content' as const,
  version: 1,
};

export const LINK_FLAVOUR = 'affine:embed-capy-link';
export const MATERIAL_FLAVOUR = 'affine:embed-capy-material';

type LinkProps = Common & { url: string; videoId: string };
export type CardMaterialKind = 'quiz' | 'flashcards';
type MaterialProps = Common & {
  kind: CardMaterialKind;
  materialId: string;
  /** The title when it was placed, shown if the workspace no longer lists it. */
  title: string;
};

export class LinkBlockModel extends GfxCompatible<LinkProps>(BlockModel) {}
export class MaterialBlockModel extends GfxCompatible<MaterialProps>(
  BlockModel
) {}

const LinkBlockSchema = defineBlockSchema({
  flavour: LINK_FLAVOUR,
  metadata: onSurface,
  props: (): LinkProps => ({ ...common(), url: '', videoId: '' }),
  toModel: () => new LinkBlockModel(),
});
const MaterialBlockSchema = defineBlockSchema({
  flavour: MATERIAL_FLAVOUR,
  metadata: onSurface,
  props: (): MaterialProps => ({
    ...common(),
    kind: 'quiz',
    materialId: '',
    title: '',
  }),
  toModel: () => new MaterialBlockModel(),
});

/** What the workspace page lends the canvas: its quizzes and sets, and opening one. */
export type WorkspaceLinks = {
  materials: () => { id: string; kind: CardMaterialKind; title: string }[];
  open: (materialId: string) => void;
};
const lent = new WeakMap<BlockStdScope, WorkspaceLinks>();
/** The material cards on screen, redrawn when the workspace's list changes. */
const shown = new Set<MaterialBlockComponent>();
export const refreshMaterialCards = () => {
  for (const card of shown) card.requestUpdate();
};
export const lendWorkspace = (std: BlockStdScope, links: WorkspaceLinks) =>
  lent.set(std, links);
export const workspaceOf = (std: BlockStdScope) => lent.get(std);

const CARD_STYLES = css`
  .capy-card {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    height: 100%;
    padding: 12px 14px;
    overflow: hidden;
    border: 1px solid var(--affine-border-color);
    border-radius: 6px;
    background: var(--affine-background-overlay-panel-color);
    color: var(--affine-text-primary-color);
    font-family: var(--affine-font-family);
    user-select: none;
  }
  .capy-card .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .capy-card .title {
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .capy-card .meta {
    overflow: hidden;
    color: var(--affine-text-secondary-color);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .capy-card.gone {
    opacity: 0.55;
  }
  .capy-video {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 6px;
    background: #000;
  }
  .capy-video img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
  }
  .capy-video .play {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
`;

const opensNewTab = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

class LinkBlockComponent extends GfxBlockComponent<LinkBlockModel> {
  static override styles = CARD_STYLES;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('dblclick', () => {
      const { url, videoId } = this.model.props;
      opensNewTab(videoId ? youtubeWatchUrl(videoId) : url);
    });
  }

  override renderGfxBlock() {
    const { url, videoId } = this.model.props;
    if (videoId)
      return html`<div class="capy-video">
        <img
          alt=""
          referrerpolicy="no-referrer"
          src="https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg"
        />
        <div class="play">
          <svg width="56" height="40" viewBox="0 0 56 40" aria-hidden="true">
            <rect width="56" height="40" rx="10" fill="#e03131" />
            <path d="M23 13v14l12-7Z" fill="#fff" />
          </svg>
        </div>
      </div>`;
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // Shown as typed.
    }
    return html`<div class="capy-card">
      <div class="row"><span class="title">${host}</span></div>
      <span class="meta">${url}</span>
    </div>`;
  }
}

class MaterialBlockComponent extends GfxBlockComponent<MaterialBlockModel> {
  static override styles = CARD_STYLES;

  private listed() {
    const { materialId } = this.model.props;
    return workspaceOf(this.std)
      ?.materials()
      .find(({ id }) => id === materialId);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    shown.delete(this);
  }

  override connectedCallback() {
    super.connectedCallback();
    shown.add(this);
    this.addEventListener('dblclick', () => {
      if (this.listed())
        workspaceOf(this.std)?.open(this.model.props.materialId);
    });
  }

  override renderGfxBlock() {
    const { kind, title } = this.model.props;
    const listed = this.listed();
    return html`<div class=${listed ? 'capy-card' : 'capy-card gone'}>
      <div class="row">
        ${
          kind === 'quiz'
            ? html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e96eb" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" /></svg>`
            : html`<svg width="18" height="18" viewBox="0 0 32 30" aria-hidden="true"><rect x="9" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" transform="rotate(8 19 10)" /><rect x="4" y="9" width="20" height="14" rx="2" fill="#e8798f" /></svg>`
        }
        <span class="title">${listed?.title ?? title}</span>
      </div>
      <span class="meta"
        >${kind === 'quiz' ? m.drawing_board_quiz() : m.drawing_board_flashcards()}${
          listed ? nothing : html` · ${m.drawing_board_card_gone()}`
        }</span
      >
    </div>`;
  }
}

for (const [tag, element] of [
  ['capy-link-card', LinkBlockComponent],
  ['capy-material-card', MaterialBlockComponent],
] as const)
  if (!customElements.get(tag)) customElements.define(tag, element);

/** Their schemas, for every board's store: a board that may not hold one refuses it
 * on load (board catalog). */
export class CardsStoreExtension extends StoreExtensionProvider {
  override name = 'capy-cards';

  override setup(context: Parameters<StoreExtensionProvider['setup']>[0]) {
    super.setup(context);
    context.register([
      BlockSchemaExtension(LinkBlockSchema),
      BlockSchemaExtension(MaterialBlockSchema),
    ]);
  }
}

export const cardViews: ExtensionType[] = [
  FlavourExtension(LINK_FLAVOUR),
  BlockViewExtension(LINK_FLAVOUR, literal`capy-link-card`),
  GfxViewInteractionExtension(LINK_FLAVOUR, {
    resizeConstraint: { lockRatio: true },
  }),
  FlavourExtension(MATERIAL_FLAVOUR),
  BlockViewExtension(MATERIAL_FLAVOUR, literal`capy-material-card`),
  GfxViewInteractionExtension(MATERIAL_FLAVOUR, {
    resizeConstraint: { minHeight: 56, minWidth: 160 },
  }),
];

/** A card in the view's middle, `w` × `h` screen pixels. */
export function addCard(
  gfx: GfxController,
  flavour: typeof LINK_FLAVOUR | typeof MATERIAL_FLAVOUR,
  props: Partial<LinkProps> | Partial<MaterialProps>,
  [w, h]: [number, number]
) {
  const surface = gfx.surface;
  if (!surface) return;
  const { centerX, centerY, zoom } = gfx.viewport;
  const box = new Bound(
    centerX - w / zoom / 2,
    centerY - h / zoom / 2,
    w / zoom,
    h / zoom
  );
  gfx.doc.captureSync();
  const id = gfx.doc.addBlock(
    flavour,
    { ...props, xywh: box.serialize() },
    surface.id
  );
  gfx.selection.set({ editing: false, elements: [id] });
  return id;
}
