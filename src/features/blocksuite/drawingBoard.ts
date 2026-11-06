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
import { ImageBlockModel } from '@blocksuite/affine/model';
import { FeatureFlagService } from '@blocksuite/affine/shared/services';
import { BlockStdScope } from '@blocksuite/affine/std';
import {
  type GfxBlockElementModel,
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
import * as Y from 'yjs';
import { m } from '@/i18n';
import { fitImageOffThread } from '@/lib/fitImageOffThread';
import { fromBase64, toBase64 } from './base64';
import { chartExtensions } from './boardChart';
import {
  forgetFormulas,
  formulaExtensions,
  formulasDrawn,
  mountSymbolRow,
} from './boardFormula';
import { addPlane, planeExtensions, planeMarks } from './boardPlane';
import './boardChartEditor';
import { closeBoardEditor } from './boardEditorShell';
import { BoardLoadError, checkSavedBoard } from './boardLoad';
import './boardPlaneEditor';
import {
  boardToolbar,
  hugeIcon,
  noLatexMarkdown,
  outlineNewShapes,
  StampTool,
  setBoardPreview,
  shapeButtonTool,
  sheetTools,
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
const VIEWS = [
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
];
const views = new ViewExtensionManager(VIEWS);
/** A teacher's view: pan and zoom, with no tools or selection toolbar. */
const READ_ONLY_TOOLS = new Set<unknown>([
  EdgelessAutoConnectViewExtension,
  EdgelessDraggingAreaViewExtension,
  EdgelessSelectedRectViewExtension,
  EdgelessToolbarViewExtension,
  ToolbarViewExtension,
]);
const readOnlyViews = new ViewExtensionManager(
  VIEWS.filter((view) => !READ_ONLY_TOOLS.has(view))
);

const PHONE_WIDTH = 768;

/** The board has no frames, but resizing a selection clears their highlight. */
class NoFrameOverlay extends Overlay {
  static override overlayName = 'frame';
  override clear() {}
  override render() {}
}

const surfaceOf = (gfx: GfxController) =>
  gfx.surfaceComponent as SurfaceBlockComponent | null;

/** The card a question with axes starts with, and the room a background gets. */
const FIRST_PLANE = { h: 520, ppu: 41, w: 820 };
/** The marking image's longest side, and its bytes after the shared compressor. */
const IMAGE_SIDE_MAX = 2400;
const IMAGE_BYTES_MAX = 300 * 1024;
/** On a board wider or taller than the image, a gap past this between groups of
 * elements shrinks to it in the image, so one dragged far away doesn't squash the rest
 * (Epo 2026-11-06). The board itself is left as it is. */
const FAR_GAP = 400;

/** What the question puts under the answer (Epo 2026-11-03), fixed: no tool moves,
 * resizes or erases it. A figure is an image the browser can fetch. */
export type BoardBackground =
  | { kind: 'blank' }
  | { kind: 'grid' }
  | { kind: 'axes'; x: [number, number]; y: [number, number] }
  | { kind: 'figure'; src: string };

export type DrawingBoardOptions = {
  /** For a fresh board; a saved one keeps the one it has. A figure is fetched again on
   * every open, as its file isn't in the saved board. Without it, a movable plane. */
  background?: BoardBackground;
  onChange?: () => void;
  /** Pan and zoom only: no tools, nothing opens for editing. */
  readOnly?: boolean;
  /** `save()`'s `doc`. A board that doesn't check out throws a BoardLoadError. */
  saved?: string;
};

export { BoardLoadError } from './boardLoad';

/** An image file drawn as the page draws it: an SVG too, which createImageBitmap
 * can't decode from a file. */
async function decodeImage(file: Blob) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Board coordinates in the image: each group of nearby elements keeps its shape, and
 * gaps past FAR_GAP between groups shrink to it. */
function closeUp(bounds: Bound[]) {
  // Groups: bounds within FAR_GAP of each other, joined.
  const group = bounds.map((_, i) => i);
  const root = (i: number): number => {
    if (group[i] !== i) group[i] = root(group[i]);
    return group[i];
  };
  const near = (a: Bound, b: Bound) =>
    a.x - FAR_GAP <= b.x + b.w &&
    b.x - FAR_GAP <= a.x + a.w &&
    a.y - FAR_GAP <= b.y + b.h &&
    b.y - FAR_GAP <= a.y + a.h;
  for (let i = 0; i < bounds.length; i++)
    for (let j = i + 1; j < bounds.length; j++)
      if (near(bounds[i], bounds[j])) group[root(i)] = root(j);
  const groups = new Map<number, Bound>();
  for (const [i, bound] of bounds.entries()) {
    const id = root(i);
    const seen = groups.get(id);
    groups.set(id, seen ? seen.unite(bound) : bound);
  }
  // Along each axis, the gaps between the groups' spans shrink to FAR_GAP.
  const shifts = (spans: [number, number][]) => {
    const order = [...spans.keys()].sort((a, b) => spans[a][0] - spans[b][0]);
    const shift = new Array<number>(spans.length).fill(0);
    let end = Number.NEGATIVE_INFINITY;
    let taken = 0;
    for (const i of order) {
      const [from, to] = spans[i];
      if (from - end > FAR_GAP && end > Number.NEGATIVE_INFINITY)
        taken += from - end - FAR_GAP;
      shift[i] = taken;
      end = Math.max(end, to);
    }
    return shift;
  };
  const ids = [...groups.keys()];
  const boxes = ids.map((id) => groups.get(id) as Bound);
  const dx = shifts(boxes.map((box) => [box.x, box.x + box.w]));
  const dy = shifts(boxes.map((box) => [box.y, box.y + box.h]));
  const by = new Map(ids.map((id, i) => [id, { dx: dx[i], dy: dy[i] }]));
  return bounds.map((_, i) => by.get(root(i)) as { dx: number; dy: number });
}

/** BlockSuite's edgeless editor on an in-memory board, opened from a saved answer when
 * there is one. */
export function mountDrawingBoard(
  container: HTMLElement,
  options: DrawingBoardOptions = {}
) {
  const saved = options.saved ? fromBase64(options.saved) : null;
  if (saved) checkSavedBoard(saved);
  const { background, readOnly = false } = options;
  if (
    background?.kind === 'axes' &&
    !(
      background.x[0] < background.x[1] &&
      background.y[0] < background.y[1] &&
      [...background.x, ...background.y].every(Number.isFinite)
    )
  )
    throw new BoardLoadError('axes ranges');
  const workspace = new TestWorkspace();
  workspace.storeExtensions = stores.get('store');
  workspace.meta.initialize();
  const doc = workspace.createDoc('board');
  const store = doc.getStore();
  if (saved) {
    Y.applyUpdate(store.spaceDoc, saved);
    store.load();
  } else {
    store.load(() => {
      const page = store.addBlock('affine:page', { title: new Text() });
      store.addBlock('affine:surface', {}, page);
    });
  }
  store.resetHistory();
  store.readonly = readOnly;
  const { onChange } = options;
  if (onChange) store.spaceDoc.on('update', onChange);
  const drawn = [
    ...formulaExtensions,
    ...planeExtensions,
    ...chartExtensions,
    NoFrameOverlay,
  ];
  const std = new BlockStdScope({
    extensions: readOnly
      ? [...readOnlyViews.get('edgeless'), ...drawn]
      : [
          ...views.get('edgeless'),
          shapeButtonTool,
          ...sheetTools,
          StampTool,
          ...drawn,
          noLatexMarkdown,
          ...boardToolbar,
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
  if (!readOnly) board?.append(history);
  // A double click types on the canvas, so the label is in the exported image.
  store.get(FeatureFlagService).setFlag('enable_edgeless_text', false);
  store.get(FeatureFlagService).setFlag('enable_note_menu_media', false);
  const gfx = std.get(GfxControllerIdentifier);
  outlineNewShapes(gfx);
  // Canvas labels measure and draw in this font (the stylesheet's @font-face).
  void document.fonts
    .load('24px "blocksuite:surface:Inter"')
    .then(() => surfaceOf(gfx)?.refresh());
  const symbols = readOnly ? null : mountSymbolRow(gfx);
  if (symbols) board?.append(symbols.element);

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
    if (!saved) addBackground();
    fitView();
    place();
  });
  const fitView = () =>
    gfx.viewport.setViewportByBound(
      everything(),
      gfx.viewport.width < PHONE_WIDTH ? [64, 12, 96, 12] : [90, 40, 130, 40]
    );

  /** A fresh board's background, out of the undo history. */
  const addBackground = () => {
    const sheet = new Bound(0, 0, FIRST_PLANE.w, FIRST_PLANE.h);
    if (!background) addPlane(gfx, sheet, FIRST_PLANE.ppu);
    else if (background.kind === 'grid')
      addPlane(gfx, sheet, FIRST_PLANE.ppu, { axes: false, locked: true });
    else if (background.kind === 'axes') {
      const [left, right] = background.x;
      const [bottom, top] = background.y;
      const ppu = Math.min(
        FIRST_PLANE.w / (right - left),
        FIRST_PLANE.h / (top - bottom)
      );
      addPlane(
        gfx,
        new Bound(0, 0, (right - left) * ppu, (top - bottom) * ppu),
        ppu,
        { locked: true, view: { x0: left, y0: top } }
      );
    }
    store.resetHistory();
  };

  /** A figure's file, fetched on every open: the saved board holds only its key, the
   * file's hash. A fresh board places it at its own size, at most the sheet's. */
  const ready = (async () => {
    if (background?.kind !== 'figure') return;
    let file: Blob;
    let size: { height: number; width: number };
    try {
      const response = await fetch(background.src);
      if (!response.ok) throw new Error(`figure: ${response.status}`);
      file = await response.blob();
      const image = await decodeImage(file);
      size = { height: image.naturalHeight, width: image.naturalWidth };
    } catch (cause) {
      throw new BoardLoadError('figure', { cause });
    }
    const sourceId = await store.blobSync.set(file);
    if (saved) return;
    const { height, width } = size;
    const scale = Math.min(1, FIRST_PLANE.w / width, FIRST_PLANE.h / height);
    const surface = store.getModelsByFlavour('affine:surface')[0];
    store.withoutTransact(() =>
      store.addBlock(
        'affine:image',
        {
          height,
          lockedBySelf: true,
          sourceId,
          width,
          xywh: new Bound(0, 0, width * scale, height * scale).serialize(),
        },
        surface
      )
    );
    store.resetHistory();
    fitView();
  })();
  ready.catch(() => undefined);

  /** A pasted image from its file; a note card by html2canvas, as it's DOM. */
  const blockImage = async (block: GfxBlockElementModel) => {
    if (block instanceof ImageBlockModel) {
      const { sourceId } = block.props;
      const blob = sourceId && (await store.blobSync.get(sourceId));
      return blob ? decodeImage(blob) : null;
    }
    const view = std.view.getBlock(block.id);
    return view ? std.get(ExportManager)._html2canvas(view) : null;
  };

  // An open plane writes its view on closing, and nothing else is in progress.
  const finishPlot = () => {
    closeBoardEditor(gfx);
    gfx.tool.setTool(DefaultTool);
  };

  return {
    /** Settles once a figure is on the board; rejects with a BoardLoadError when its
     * file can't be fetched. */
    ready,
    /** The board to store, with no undo history: a fresh document keeps only what's
     * on the board (200 plane clicks were 606 KB live, 7.5 KB this way). */
    save: () => {
      finishPlot();
      const fresh = new Y.Doc();
      Y.applyUpdate(fresh, Y.encodeStateAsUpdate(store.spaceDoc));
      const update = Y.encodeStateAsUpdate(fresh);
      fresh.destroy();
      return { bytes: update.byteLength, doc: toBase64(update) };
    },
    /** The board as it is, leaving a tool in use alone. */
    snapshot: () => toBase64(Y.encodeStateAsUpdate(store.spaceDoc)),
    stats: () => ({
      blocks: gfx.layer.blocks.map((block) => block.flavour),
      bytes: Y.encodeStateAsUpdate(store.spaceDoc).byteLength,
      canvas: gfx.layer.canvasElements.map((element) => element.type),
      marks: planeMarks(gfx),
    }),
    /** The canvas as it stands, for marking, through the shared image compressor:
     * every card with the view it was left at, and what's drawn over and around them.
     * Something dragged far away is drawn nearer (FAR_GAP). */
    toImage: async () => {
      if (!readOnly) finishPlot();
      await ready.catch(() => undefined);
      await formulasDrawn(gfx);
      const renderer = surfaceOf(gfx)?.renderer;
      if (!(renderer instanceof CanvasRenderer))
        throw new Error('drawing board: no canvas renderer');
      const items = [...gfx.layer.canvasElements, ...gfx.layer.blocks];
      const bounds = items.map((item) => Bound.deserialize(item.xywh));
      const whole = everything();
      const far = Math.max(whole.w, whole.h) > IMAGE_SIDE_MAX;
      const shifts = far
        ? closeUp(bounds)
        : bounds.map(() => ({ dx: 0, dy: 0 }));
      const shiftOf = new Map(items.map((item, i) => [item.id, shifts[i]]));
      const placed = bounds.map(
        (box, i) =>
          new Bound(box.x - shifts[i].dx, box.y - shifts[i].dy, box.w, box.h)
      );
      const all = getCommonBound(placed) ?? whole;
      const bound = new Bound(all.x - 8, all.y - 8, all.w + 16, all.h + 16);
      const scale = Math.min(2, IMAGE_SIDE_MAX / Math.max(bound.w, bound.h));
      const output = document.createElement('canvas');
      output.width = Math.round(bound.w * scale);
      output.height = Math.round(bound.h * scale);
      const ctx = output.getContext('2d');
      if (!ctx) throw new Error('drawing board: no 2d canvas');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, output.width, output.height);
      // Layer by layer, so what's covered on the screen is covered here. BlockSuite's
      // export draws every note under every stroke, at the device's scale. Each group
      // drawn nearer is drawn on its own.
      for (const layer of gfx.layer.layers) {
        if (layer.type === 'canvas') {
          const byShift = new Map<string, typeof layer.elements>();
          for (const element of layer.elements) {
            const { dx, dy } = shiftOf.get(element.id) ?? { dx: 0, dy: 0 };
            const key = `${dx},${dy}`;
            byShift.set(key, [...(byShift.get(key) ?? []), element]);
          }
          for (const [key, elements] of byShift) {
            const [dx, dy] = key.split(',').map(Number);
            const from = new Bound(
              bound.x + dx,
              bound.y + dy,
              bound.w,
              bound.h
            );
            ctx.drawImage(
              renderer.getCanvasByBound(
                from,
                elements,
                undefined,
                false,
                false,
                scale
              ),
              0,
              0,
              output.width,
              output.height
            );
          }
          continue;
        }
        for (const block of layer.elements) {
          const { h, w, x, y } = Bound.deserialize(block.xywh);
          const { dx, dy } = shiftOf.get(block.id) ?? { dx: 0, dy: 0 };
          const place = [
            (x - dx - bound.x) * scale,
            (y - dy - bound.y) * scale,
            w * scale,
            h * scale,
          ] as const;
          const image = await blockImage(block);
          if (image) ctx.drawImage(image, ...place);
        }
      }
      const png = await new Promise<Blob | null>((resolve) =>
        output.toBlob(resolve, 'image/png')
      );
      if (!png) throw new Error('drawing board: no image');
      // The encode runs in the compressor's worker; drawing needs the page.
      return fitImageOffThread(
        new File([png], 'drawing.png', { type: 'image/png' }),
        IMAGE_BYTES_MAX
      );
    },
    unmount: () => {
      cancelAnimationFrame(frame);
      subscription.unsubscribe();
      historyUpdates.unsubscribe();
      if (onChange) store.spaceDoc.off('update', onChange);
      symbols?.unmount();
      closeBoardEditor(gfx);
      forgetFormulas();
      render(null, history);
      render(null, container);
    },
  };
}
