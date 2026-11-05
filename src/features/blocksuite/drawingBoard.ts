import '@toeverything/theme/style.css';
import { ImageStoreExtension } from '@blocksuite/affine/blocks/image/store';
import { ImageViewExtension } from '@blocksuite/affine/blocks/image/view';
import { ListStoreExtension } from '@blocksuite/affine/blocks/list/store';
import { ListViewExtension } from '@blocksuite/affine/blocks/list/view';
import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { NoteViewExtension } from '@blocksuite/affine/blocks/note/view';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { ParagraphViewExtension } from '@blocksuite/affine/blocks/paragraph/view';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import { RootViewExtension } from '@blocksuite/affine/blocks/root/view';
import {
  CanvasRenderer,
  ExportManager,
} from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { SurfaceViewExtension } from '@blocksuite/affine/blocks/surface/view';
import {
  StoreExtensionManager,
  ViewExtensionManager,
} from '@blocksuite/affine/ext-loader';
import { FoundationStoreExtension } from '@blocksuite/affine/foundation/store';
import { FoundationViewExtension } from '@blocksuite/affine/foundation/view';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { BrushViewExtension } from '@blocksuite/affine/gfx/brush/view';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { ConnectorViewExtension } from '@blocksuite/affine/gfx/connector/view';
import { GroupStoreExtension } from '@blocksuite/affine/gfx/group/store';
import { GroupViewExtension } from '@blocksuite/affine/gfx/group/view';
import { NoteViewExtension as GfxNoteViewExtension } from '@blocksuite/affine/gfx/note/view';
import { PointerViewExtension } from '@blocksuite/affine/gfx/pointer/view';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { ShapeViewExtension } from '@blocksuite/affine/gfx/shape/view';
import { TextStoreExtension } from '@blocksuite/affine/gfx/text/store';
import { TextViewExtension } from '@blocksuite/affine/gfx/text/view';
import { Bound } from '@blocksuite/affine/global/gfx';
import { InlineCommentViewExtension } from '@blocksuite/affine/inlines/comment/view';
import { FootnoteStoreExtension } from '@blocksuite/affine/inlines/footnote/store';
import { FootnoteViewExtension } from '@blocksuite/affine/inlines/footnote/view';
import { LatexStoreExtension as InlineLatexStoreExtension } from '@blocksuite/affine/inlines/latex/store';
import { LatexViewExtension as InlineLatexViewExtension } from '@blocksuite/affine/inlines/latex/view';
import { LinkStoreExtension } from '@blocksuite/affine/inlines/link/store';
import { LinkViewExtension } from '@blocksuite/affine/inlines/link/view';
import { MentionViewExtension } from '@blocksuite/affine/inlines/mention/view';
import { InlinePresetStoreExtension } from '@blocksuite/affine/inlines/preset/store';
import { InlinePresetViewExtension } from '@blocksuite/affine/inlines/preset/view';
import { ReferenceStoreExtension } from '@blocksuite/affine/inlines/reference/store';
import { ReferenceViewExtension } from '@blocksuite/affine/inlines/reference/view';
import { FeatureFlagService } from '@blocksuite/affine/shared/services';
import { BlockStdScope } from '@blocksuite/affine/std';
import { GfxControllerIdentifier } from '@blocksuite/affine/std/gfx';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { EdgelessAutoConnectViewExtension } from '@blocksuite/affine/widgets/edgeless-auto-connect/view';
import { EdgelessDraggingAreaViewExtension } from '@blocksuite/affine/widgets/edgeless-dragging-area/view';
import { EdgelessSelectedRectViewExtension } from '@blocksuite/affine/widgets/edgeless-selected-rect/view';
import { EdgelessToolbarViewExtension } from '@blocksuite/affine/widgets/edgeless-toolbar/view';
import { EdgelessZoomToolbarViewExtension } from '@blocksuite/affine/widgets/edgeless-zoom-toolbar/view';
import { ToolbarViewExtension } from '@blocksuite/affine/widgets/toolbar/view';
import { ViewportOverlayViewExtension } from '@blocksuite/affine/widgets/viewport-overlay/view';
import { html, render } from 'lit';
import * as Y from 'yjs';

const stores = new StoreExtensionManager([
  ImageStoreExtension,
  ListStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
  RootStoreExtension,
  SurfaceStoreExtension,
  FoundationStoreExtension,
  BrushStoreExtension,
  ConnectorStoreExtension,
  GroupStoreExtension,
  ShapeStoreExtension,
  TextStoreExtension,
  InlineLatexStoreExtension,
  ReferenceStoreExtension,
  FootnoteStoreExtension,
  LinkStoreExtension,
  InlinePresetStoreExtension,
]);
const views = new ViewExtensionManager([
  FoundationViewExtension,
  PointerViewExtension,
  GfxNoteViewExtension,
  BrushViewExtension,
  ShapeViewExtension,
  ConnectorViewExtension,
  GroupViewExtension,
  TextViewExtension,
  ImageViewExtension,
  ListViewExtension,
  NoteViewExtension,
  ParagraphViewExtension,
  SurfaceViewExtension,
  RootViewExtension,
  InlineLatexViewExtension,
  ReferenceViewExtension,
  FootnoteViewExtension,
  MentionViewExtension,
  InlineCommentViewExtension,
  LinkViewExtension,
  InlinePresetViewExtension,
  EdgelessAutoConnectViewExtension,
  EdgelessDraggingAreaViewExtension,
  EdgelessSelectedRectViewExtension,
  EdgelessToolbarViewExtension,
  EdgelessZoomToolbarViewExtension,
  ToolbarViewExtension,
  ViewportOverlayViewExtension,
]);

/** The sheet an answer is drawn on, in the board's own coordinates. */
const SHEET = { h: 520, w: 820, x: 0, y: 0 };

/** Squared paper with x and y axes: the part's background, never in the answer. */
function axesSheet({ h, w }: typeof SHEET) {
  const lines: string[] = [];
  for (let x = 0; x <= w; x += 41)
    lines.push(`<path d="M${x} 0V${h}" stroke="#ececea"/>`);
  for (let y = 0; y <= h; y += 40)
    lines.push(`<path d="M0 ${y}H${w}" stroke="#ececea"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>${lines.join('')}<path d="M41 0V${h}M0 360H${w}" stroke="#8b8b88" stroke-width="1.5"/></svg>`;
}

function fromBase64(saved: string) {
  return Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
}

/** BlockSuite's edgeless editor on an in-memory board over a fixed sheet, opened
 * from a saved answer when there is one. */
export function mountDrawingBoard(
  container: HTMLElement,
  options: { saved?: string } = {}
) {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = stores.get('store');
  workspace.meta.initialize();
  const doc = workspace.createDoc('board');
  const store = doc.getStore();
  if (options.saved) {
    Y.applyUpdate(store.spaceDoc, fromBase64(options.saved));
    store.load();
  } else {
    store.load(() => {
      const page = store.addBlock('affine:page', { title: new Text() });
      store.addBlock('affine:surface', {}, page);
    });
  }
  store.resetHistory();
  const std = new BlockStdScope({ extensions: views.get('edgeless'), store });
  render(
    html`<div class="affine-edgeless-viewport">${std.render()}</div>`,
    container
  );
  // A double click types on the canvas, so the label is in the exported image.
  store.get(FeatureFlagService).setFlag('enable_edgeless_text', false);
  const gfx = std.get(GfxControllerIdentifier);

  // The sheet sits under the strokes and moves with the board, outside the
  // document, so no tool can select or erase it.
  const svg = axesSheet(SHEET);
  const sheet = document.createElement('div');
  sheet.style.cssText =
    'position:absolute;pointer-events:none;box-shadow:0 0 0 1px #d9d9d6;border-radius:6px;overflow:hidden';
  sheet.innerHTML = svg;
  const place = () => {
    const [left, top] = gfx.viewport.toViewCoord(SHEET.x, SHEET.y);
    const { zoom } = gfx.viewport;
    sheet.style.left = `${left}px`;
    sheet.style.top = `${top}px`;
    sheet.style.width = `${SHEET.w}px`;
    sheet.style.height = `${SHEET.h}px`;
    sheet.style.transform = `scale(${zoom})`;
    sheet.style.transformOrigin = '0 0';
  };
  const subscription = gfx.viewport.viewportUpdated.subscribe(place);
  let frame = requestAnimationFrame(function mountSheet() {
    const background = container.querySelector('.edgeless-background');
    if (!background || !gfx.viewport.width) {
      frame = requestAnimationFrame(mountSheet);
      return;
    }
    background.prepend(sheet);
    gfx.viewport.setViewportByBound(
      new Bound(SHEET.x, SHEET.y, SHEET.w, SHEET.h),
      [90, 40, 130, 40]
    );
    place();
  });

  return {
    save: () =>
      btoa(String.fromCharCode(...Y.encodeStateAsUpdate(store.spaceDoc))),
    stats: () => ({
      blocks: gfx.layer.blocks.map((block) => block.flavour),
      bytes: Y.encodeStateAsUpdate(store.spaceDoc).byteLength,
      canvas: gfx.layer.canvasElements.map((element) => element.type),
    }),
    /** The sheet and what's on it, for marking. */
    toImage: async () => {
      const renderer = gfx.surfaceComponent?.renderer;
      if (!(renderer instanceof CanvasRenderer)) return null;
      const bound = new Bound(SHEET.x, SHEET.y, SHEET.w, SHEET.h);
      const output = document.createElement('canvas');
      output.width = SHEET.w * 2;
      output.height = SHEET.h * 2;
      const ctx = output.getContext('2d');
      if (!ctx) return null;
      ctx.scale(2, 2);
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      ctx.drawImage(image, 0, 0);
      const blocks = gfx.getElementsByBound(bound, { type: 'block' });
      const elements = gfx.getElementsByBound(bound, { type: 'canvas' });
      // Note cards are DOM, so BlockSuite's export draws them. It doesn't draw
      // the sheet under them yet.
      if (blocks.length) {
        const drawn = await std
          .get(ExportManager)
          .edgelessToCanvas(renderer, bound, gfx, blocks, elements);
        return drawn?.toDataURL('image/png') ?? null;
      }
      ctx.drawImage(
        renderer.getCanvasByBound(bound, elements),
        0,
        0,
        SHEET.w,
        SHEET.h
      );
      return output.toDataURL('image/png');
    },
    unmount: () => {
      cancelAnimationFrame(frame);
      subscription.unsubscribe();
      render(null, container);
    },
  };
}
