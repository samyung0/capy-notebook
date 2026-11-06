import '@toeverything/theme/style.css';
import './drawingBoard.css';
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
  DefaultTool,
  ExportManager,
  Overlay,
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
import { HistoryExtension, Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { EdgelessAutoConnectViewExtension } from '@blocksuite/affine/widgets/edgeless-auto-connect/view';
import { EdgelessDraggingAreaViewExtension } from '@blocksuite/affine/widgets/edgeless-dragging-area/view';
import { EdgelessSelectedRectViewExtension } from '@blocksuite/affine/widgets/edgeless-selected-rect/view';
import { EdgelessToolbarViewExtension } from '@blocksuite/affine/widgets/edgeless-toolbar/view';
import { EdgelessZoomToolbarViewExtension } from '@blocksuite/affine/widgets/edgeless-zoom-toolbar/view';
import { ToolbarViewExtension } from '@blocksuite/affine/widgets/toolbar/view';
import { ViewportOverlayViewExtension } from '@blocksuite/affine/widgets/viewport-overlay/view';
import { Redo03Icon, Undo03Icon } from '@hugeicons/core-free-icons';
import { html, render } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import * as Y from 'yjs';
import { m } from '@/i18n';
import { fromBase64, toBase64 } from './base64';
import {
  formulaExtensions,
  formulasDrawn,
  mountSymbolRow,
} from './boardFormula';
import { SHEET, UNIT } from './boardGeometry';
import {
  mathsTool,
  outlineNewShapes,
  PlotTool,
  StampTool,
  setBoardPreview,
  shapeButtonTool,
} from './boardTools';

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

const PHONE_WIDTH = 768;

/** The board has no frames, but resizing a selection clears their highlight. */
class NoFrameOverlay extends Overlay {
  static override overlayName = 'frame';
  clear() {}
  override render() {}
}

/** A Hugeicons icon's data as an SVG, for the board's Lit templates. */
function hugeIcon(
  data: readonly (readonly [string, Record<string, string>])[]
) {
  const body = data
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .filter(([name]) => name !== 'key')
          .map(
            ([name, value]) =>
              `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`
          )
          .join(' ')}/>`
    )
    .join('');
  return unsafeSVG(
    `<svg fill="none" height="24" viewBox="0 0 24 24" width="24">${body}</svg>`
  );
}

/** Squared paper with numbered x and y axes: the part's background, never in the
 * answer. SVG text, because the same drawing goes into the marking image, where
 * only system fonts reach it. */
function axesSheet({ h, origin, w }: typeof SHEET) {
  const lines: string[] = [];
  for (let x = 0; x <= w; x += UNIT.x)
    lines.push(`<path d="M${x} 0V${h}" stroke="#ececea"/>`);
  for (let y = 0; y <= h; y += UNIT.y)
    lines.push(`<path d="M0 ${y}H${w}" stroke="#ececea"/>`);
  const label = 'font-family="Arial, sans-serif" font-size="12" fill="#77757d"';
  for (let x = origin.x + UNIT.x, n = 1; x < w; x += UNIT.x, n++)
    lines.push(
      `<text x="${x}" y="${origin.y + 16}" text-anchor="middle" ${label}>${n}</text>`
    );
  for (let y = origin.y - UNIT.y, n = 1; y > 0; y -= UNIT.y, n++)
    lines.push(
      `<text x="${origin.x - 7}" y="${y + 4}" text-anchor="end" ${label}>${n}</text>`
    );
  for (let y = origin.y + UNIT.y, n = 1; y < h; y += UNIT.y, n++)
    lines.push(
      `<text x="${origin.x - 7}" y="${y + 4}" text-anchor="end" ${label}>−${n}</text>`
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>${lines.join('')}<path d="M${origin.x} 0V${h}M0 ${origin.y}H${w}" stroke="#8b8b88" stroke-width="1.5"/></svg>`;
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
  const std = new BlockStdScope({
    extensions: [
      ...views.get('edgeless'),
      shapeButtonTool,
      mathsTool,
      PlotTool,
      StampTool,
      ...formulaExtensions,
      NoFrameOverlay,
    ],
    store,
  });
  // Undo and redo sit outside the toolbar: beside zoom, or on a phone top right,
  // left of Done. BlockSuite keeps them on the keyboard only; a phone has none.
  const history = document.createElement('div');
  history.className = 'capy-board-history';
  const drawHistory = () =>
    render(
      html`<button
          aria-label=${m.drawing_board_undo()}
          ?disabled=${!store.canUndo}
          title=${m.drawing_board_undo()}
          type="button"
          @click=${() => store.undo()}
        >
          ${hugeIcon(Undo03Icon)}
        </button>
        <button
          aria-label=${m.drawing_board_redo()}
          ?disabled=${!store.canRedo}
          title=${m.drawing_board_redo()}
          type="button"
          @click=${() => store.redo()}
        >
          ${hugeIcon(Redo03Icon)}
        </button>`,
      history
    );
  drawHistory();
  const historyUpdates = store
    .get(HistoryExtension)
    .onUpdated.subscribe(drawHistory);
  render(
    html`<div class="affine-edgeless-viewport capy-board">${std.render()}</div>`,
    container
  );
  const board = container.querySelector('.capy-board');
  board?.append(history);
  // A double click types on the canvas, so the label is in the exported image.
  store.get(FeatureFlagService).setFlag('enable_edgeless_text', false);
  store.get(FeatureFlagService).setFlag('enable_note_menu_media', false);
  const gfx = std.get(GfxControllerIdentifier);
  outlineNewShapes(gfx);
  // Canvas labels measure and draw in this font (the stylesheet's @font-face).
  void document.fonts
    .load('24px "blocksuite:surface:Inter"')
    .then(() => gfx.surfaceComponent?.refresh());
  const symbols = mountSymbolRow(gfx);
  board?.append(symbols.element);

  // The sheet sits under the strokes and moves with the board, outside the
  // document, so no tool can select or erase it.
  const svg = axesSheet(SHEET);
  const sheet = document.createElement('div');
  sheet.style.cssText =
    'position:absolute;pointer-events:none;box-shadow:0 0 0 1px #d9d9d6;border-radius:6px;overflow:hidden';
  sheet.innerHTML = svg;
  // What the plotting tools show while placing, above the paper.
  const preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  preview.setAttribute('viewBox', `0 0 ${SHEET.w} ${SHEET.h}`);
  preview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  sheet.append(preview);
  setBoardPreview(gfx, preview);
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
      gfx.viewport.width < PHONE_WIDTH ? [64, 12, 96, 12] : [90, 40, 130, 40]
    );
    place();
  });

  // Leaving a plotting tool keeps a curve still being placed.
  const finishPlot = () => gfx.tool.setTool(DefaultTool);

  return {
    save: () => {
      finishPlot();
      return toBase64(Y.encodeStateAsUpdate(store.spaceDoc));
    },
    stats: () => ({
      blocks: gfx.layer.blocks.map((block) => block.flavour),
      bytes: Y.encodeStateAsUpdate(store.spaceDoc).byteLength,
      canvas: gfx.layer.canvasElements.map((element) => element.type),
    }),
    /** The sheet and what's on it, for marking. */
    toImage: async () => {
      finishPlot();
      await formulasDrawn(gfx);
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
      // Note cards are DOM, so BlockSuite's export draws them with the strokes, on
      // a canvas with a 50 px margin at the device's scale.
      if (blocks.length) {
        const drawn = await std
          .get(ExportManager)
          .edgelessToCanvas(renderer, bound, gfx, blocks, elements);
        if (!drawn) return null;
        const scale = window.devicePixelRatio || 1;
        ctx.drawImage(
          drawn,
          50 * scale,
          50 * scale,
          SHEET.w * scale,
          SHEET.h * scale,
          0,
          0,
          SHEET.w,
          SHEET.h
        );
        return output.toDataURL('image/png');
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
      historyUpdates.unsubscribe();
      symbols.unmount();
      render(null, history);
      render(null, container);
    },
  };
}
