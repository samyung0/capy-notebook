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
  type SurfaceBlockComponent,
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
import { Bound, getCommonBound } from '@blocksuite/affine/global/gfx';
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
import {
  type GfxController,
  GfxControllerIdentifier,
} from '@blocksuite/affine/std/gfx';
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
import { addPlane, planeExtensions, planeMarks } from './boardPlane';
import { closePlaneEditor } from './boardPlaneEditor';
import {
  mathsTool,
  noLatexMarkdown,
  outlineNewShapes,
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

const PHONE_WIDTH = 768;

/** The board has no frames, but resizing a selection clears their highlight. */
class NoFrameOverlay extends Overlay {
  static override overlayName = 'frame';
  override clear() {}
  override render() {}
}

/** A Hugeicons icon's data as an SVG, for the board's Lit templates. */
function hugeIcon(icon: unknown) {
  const data = icon as readonly (readonly [string, Record<string, string>])[];
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

const surfaceOf = (gfx: GfxController) =>
  gfx.surfaceComponent as SurfaceBlockComponent | null;

/** The card a question with axes starts with. */
const FIRST_PLANE = { h: 520, ppu: 41, w: 820 };
/** The marking image's longest side. */
const IMAGE_SIDE_MAX = 2400;

/** BlockSuite's edgeless editor on an in-memory board over a fixed sheet, opened
 * from a saved answer when there is one. */
export function mountDrawingBoard(
  container: HTMLElement,
  options: { onChange?: () => void; saved?: string } = {}
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
  const { onChange } = options;
  if (onChange) store.spaceDoc.on('update', onChange);
  const std = new BlockStdScope({
    extensions: [
      ...views.get('edgeless'),
      shapeButtonTool,
      mathsTool,
      StampTool,
      ...formulaExtensions,
      ...planeExtensions,
      noLatexMarkdown,
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
    .then(() => surfaceOf(gfx)?.refresh());
  const symbols = mountSymbolRow(gfx);
  board?.append(symbols.element);

  // A preset being sized shows on this layer, under the strokes and outside the
  // document. It moves with the board.
  const layer = document.createElement('div');
  layer.style.cssText =
    'position:absolute;pointer-events:none;width:1px;height:1px;transform-origin:0 0';
  const preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  preview.style.cssText =
    'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible';
  layer.append(preview);
  setBoardPreview(gfx, preview);
  const place = () => {
    const [left, top] = gfx.viewport.toViewCoord(0, 0);
    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
    layer.style.transform = `scale(${gfx.viewport.zoom})`;
  };
  const subscription = gfx.viewport.viewportUpdated.subscribe(place);
  const everything = () => {
    const elements = gfx.layer.canvasElements;
    const blocks = gfx.layer.blocks;
    return (
      getCommonBound([...elements, ...blocks]) ?? new Bound(0, 0, 820, 520)
    );
  };
  let frame = requestAnimationFrame(function mountLayer() {
    const background = container.querySelector('.edgeless-background');
    if (!background || !gfx.viewport.width) {
      frame = requestAnimationFrame(mountLayer);
      return;
    }
    background.prepend(layer);
    if (!options.saved) {
      addPlane(
        gfx,
        new Bound(0, 0, FIRST_PLANE.w, FIRST_PLANE.h),
        FIRST_PLANE.ppu
      );
      store.resetHistory();
    }
    gfx.viewport.setViewportByBound(
      everything(),
      gfx.viewport.width < PHONE_WIDTH ? [64, 12, 96, 12] : [90, 40, 130, 40]
    );
    place();
  });

  // An open plane writes its view on closing, and nothing else is in progress.
  const finishPlot = () => {
    closePlaneEditor(gfx);
    gfx.tool.setTool(DefaultTool);
  };

  return {
    save: () => {
      finishPlot();
      return toBase64(Y.encodeStateAsUpdate(store.spaceDoc));
    },
    /** The board as it is, leaving a tool in use alone. */
    snapshot: () => toBase64(Y.encodeStateAsUpdate(store.spaceDoc)),
    stats: () => ({
      blocks: gfx.layer.blocks.map((block) => block.flavour),
      bytes: Y.encodeStateAsUpdate(store.spaceDoc).byteLength,
      canvas: gfx.layer.canvasElements.map((element) => element.type),
      marks: planeMarks(gfx),
    }),
    /** The canvas as it stands, for marking: every card with the view it was left
     * at, and what's drawn over and around them. */
    toImage: async () => {
      finishPlot();
      await formulasDrawn(gfx);
      const renderer = surfaceOf(gfx)?.renderer;
      if (!(renderer instanceof CanvasRenderer)) return null;
      const all = everything();
      const bound = new Bound(all.x - 8, all.y - 8, all.w + 16, all.h + 16);
      const scale = Math.min(2, IMAGE_SIDE_MAX / Math.max(bound.w, bound.h));
      const output = document.createElement('canvas');
      output.width = Math.round(bound.w * scale);
      output.height = Math.round(bound.h * scale);
      const ctx = output.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, output.width, output.height);
      const blocks = gfx.getElementsByBound(bound, { type: 'block' });
      const elements = gfx.getElementsByBound(bound, { type: 'canvas' });
      // Note cards are DOM, so BlockSuite's export draws them with the strokes, on
      // a canvas with a 50 px margin at the device's scale.
      if (blocks.length) {
        const drawn = await std
          .get(ExportManager)
          .edgelessToCanvas(renderer, bound, gfx, blocks, elements);
        if (!drawn) return null;
        const device = window.devicePixelRatio || 1;
        ctx.drawImage(
          drawn,
          50 * device,
          50 * device,
          bound.w * device,
          bound.h * device,
          0,
          0,
          output.width,
          output.height
        );
        return output.toDataURL('image/png');
      }
      ctx.drawImage(
        renderer.getCanvasByBound(bound, elements),
        0,
        0,
        output.width,
        output.height
      );
      return output.toDataURL('image/png');
    },
    unmount: () => {
      cancelAnimationFrame(frame);
      subscription.unsubscribe();
      historyUpdates.unsubscribe();
      if (onChange) store.spaceDoc.off('update', onChange);
      symbols.unmount();
      closePlaneEditor(gfx);
      render(null, history);
      render(null, container);
    },
  };
}
