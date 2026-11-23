import '@toeverything/theme/style.css';
import './chrome.css';
import { toastText } from './chromeLabels';
import './drawingBoard.css';
import { setImageUploadHandler } from '@blocksuite/affine/blocks/image';
import { ImageStoreExtension } from '@blocksuite/affine/blocks/image/store';
import { ImageViewExtension } from '@blocksuite/affine/blocks/image/view';
import { ListStoreExtension } from '@blocksuite/affine/blocks/list/store';
import { ListViewExtension } from '@blocksuite/affine/blocks/list/view';
import {
  closeNoteSizes,
  dropNoteSizes,
  measureNoteSizesAgain,
  openNoteSizes,
  saveNoteSizes,
} from '@blocksuite/affine/blocks/note';
import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { NoteViewExtension } from '@blocksuite/affine/blocks/note/view';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { ParagraphViewExtension } from '@blocksuite/affine/blocks/paragraph/view';
import { createElementsFromClipboardDataCommand } from '@blocksuite/affine/blocks/root';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import { RootViewExtension } from '@blocksuite/affine/blocks/root/view';
import {
  CanvasRenderer,
  DefaultTool,
  EdgelessClipboardConfig,
  EdgelessClipboardConfigIdentifier,
  EdgelessCRUDIdentifier,
  ExportManager,
  Overlay,
  type SurfaceBlockComponent,
} from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { SurfaceViewExtension } from '@blocksuite/affine/blocks/surface/view';
import { setToastHandler } from '@blocksuite/affine/components/toast';
import {
  StoreExtensionManager,
  type ViewExtensionContext,
  ViewExtensionManager,
  ViewExtensionProvider,
} from '@blocksuite/affine/ext-loader';
import { FoundationStoreExtension } from '@blocksuite/affine/foundation/store';
import { FoundationViewExtension } from '@blocksuite/affine/foundation/view';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { BrushViewExtension } from '@blocksuite/affine/gfx/brush/view';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { ConnectorViewExtension } from '@blocksuite/affine/gfx/connector/view';
import { GroupStoreExtension } from '@blocksuite/affine/gfx/group/store';
import { GroupViewExtension } from '@blocksuite/affine/gfx/group/view';
import {
  MindMapDragExtension,
  MindMapIndicatorOverlay,
  MindMapInteraction,
  MindMapView,
  MindmapDomRendererExtension,
  MindmapElementRendererExtension,
  mindmapToolbarExtension,
  shapeMindmapToolbarExtension,
} from '@blocksuite/affine/gfx/mindmap';
import { MindmapStoreExtension } from '@blocksuite/affine/gfx/mindmap/store';
import { MindmapViewExtension } from '@blocksuite/affine/gfx/mindmap/view';
import { NoteViewExtension as GfxNoteViewExtension } from '@blocksuite/affine/gfx/note/view';
import { PanTool } from '@blocksuite/affine/gfx/pointer';
import { PointerViewExtension } from '@blocksuite/affine/gfx/pointer/view';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { ShapeViewExtension } from '@blocksuite/affine/gfx/shape/view';
import { TextStoreExtension } from '@blocksuite/affine/gfx/text/store';
import { TextViewExtension } from '@blocksuite/affine/gfx/text/view';
import { Bound, getCommonBound } from '@blocksuite/affine/global/gfx';
import { InlineCommentViewExtension } from '@blocksuite/affine/inlines/comment/view';
import { FootnoteStoreExtension } from '@blocksuite/affine/inlines/footnote/store';
import { FootnoteViewExtension } from '@blocksuite/affine/inlines/footnote/view';
import {
  LatexEditorUnitSpecExtension,
  LatexInlineSpecExtension,
} from '@blocksuite/affine/inlines/latex';
import { LatexStoreExtension as InlineLatexStoreExtension } from '@blocksuite/affine/inlines/latex/store';
import { LinkStoreExtension } from '@blocksuite/affine/inlines/link/store';
import { LinkViewExtension } from '@blocksuite/affine/inlines/link/view';
import { MentionViewExtension } from '@blocksuite/affine/inlines/mention/view';
import { InlinePresetStoreExtension } from '@blocksuite/affine/inlines/preset/store';
import { InlinePresetViewExtension } from '@blocksuite/affine/inlines/preset/view';
import { ReferenceStoreExtension } from '@blocksuite/affine/inlines/reference/store';
import { ReferenceViewExtension } from '@blocksuite/affine/inlines/reference/view';
import {
  ColorScheme,
  ImageBlockModel,
  MindmapElementModel,
} from '@blocksuite/affine/model';
import { ImageAdapter } from '@blocksuite/affine/shared/adapters';
import {
  FeatureFlagService,
  ThemeProvider,
} from '@blocksuite/affine/shared/services';
import {
  BlockStdScope,
  ClipboardAdapterConfigIdentifier,
  isGfxBlockComponent,
  StdIdentifier,
} from '@blocksuite/affine/std';
import {
  type GfxBlockElementModel,
  type GfxController,
  GfxControllerIdentifier,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from '@blocksuite/affine/std/gfx';
import {
  type BlockSnapshot,
  type ExtensionType,
  HistoryExtension,
  nanoid,
  type SliceSnapshot,
  type Store,
  Text,
} from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { EdgelessAutoConnectViewExtension } from '@blocksuite/affine/widgets/edgeless-auto-connect/view';
import { EdgelessDraggingAreaViewExtension } from '@blocksuite/affine/widgets/edgeless-dragging-area/view';
import { EdgelessSelectedRectViewExtension } from '@blocksuite/affine/widgets/edgeless-selected-rect/view';
import { EdgelessToolbarViewExtension } from '@blocksuite/affine/widgets/edgeless-toolbar/view';
import { SlashMenuViewExtension } from '@blocksuite/affine/widgets/slash-menu/view';
import { ToolbarViewExtension } from '@blocksuite/affine/widgets/toolbar/view';
import { ViewportOverlayViewExtension } from '@blocksuite/affine/widgets/viewport-overlay/view';
import {
  Delete02Icon,
  Download01Icon,
  Redo03Icon,
  Undo03Icon,
} from '@hugeicons/core-free-icons';
import { combinedDarkCssVariables } from '@toeverything/theme';
import { render } from 'lit';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { userToast } from '@/components/ui/userToast';
import { cardUndo, onCardState } from '@/features/canvas/materialCardHosts';
import type { PlaneOpener } from '@/features/graph/planeEditing';
import { contentSizeKilobytes } from '@/features/notes/documentStats';
import { m } from '@/i18n';
import { BOARD_OFFLINE_MARGIN } from '@/lib/const';
import { fitImageOffThread } from '@/lib/fitImageOffThread';
import { fromBase64, toBase64 } from './base64';
import { BoardBlobSource } from './boardBlobs';
import { ChartElementModel, chartExtensions, openChart } from './boardChart';
import { asImage } from './boardData';
import {
  formulaExtensions,
  formulasDrawn,
  mountSymbolRow,
  openBlankFormula,
} from './boardFormula';
import { forgetFormulas } from './boardFormulaDraw';
import { refusesAdds, setBoardFull } from './boardFull';
import { closeUp, IMAGE_SIDE_MAX, type Vec } from './boardGeometry';
import type { BoardImages } from './boardImages';
import { watchNoteLinks } from './boardNoteLinks';
import {
  addPlane,
  openPlane,
  PlaneElementModel,
  planeExtensions,
  planeMarks,
} from './boardPlane';
import './boardChartEditor';
import {
  CardsStoreExtension,
  cardViews,
  lendWorkspace,
  MATERIAL_FLAVOUR,
  refreshMaterialCards,
  type WorkspaceLinks,
} from './boardCards';
import { closeBoardEditor, watchBoardEditor } from './boardEditorShell';
import { keepToCatalog, savedCopy } from './boardKeep';
import { checkSavedBoard } from './boardLoad';
import { BoardMenu } from './boardMenu';
import { PictureStoreExtension, pictureViews } from './boardPicture';
import { setPlaneOpener } from './boardPlaneEditor';
import { boardPresenceView } from './boardPresenceView';
import { readOnlyCopy, TapPanTool } from './boardReadOnly';
import type { BoardKind } from './boardRules';
import {
  boardToolbar,
  markBoard,
  noLatexMarkdown,
  noteButtonTool,
  outlineNewShapes,
  placePiece,
  refreshMiscLists,
  StampTool,
  setBoardPreview,
  shapeButtonTool,
  sheetTools,
} from './boardTools';
import { unknownStore } from './boardUnknown';
import { unknownViews } from './boardUnknownView';
import { BoardUploads, boardUploads } from './boardUploads';
import { followTextEditors, openRoomStore } from './roomStore';

// BlockSuite's notices show in the app's own toast (local change 33), in the
// app's language (chromeLabels.ts). They come as bare English strings, a refusal
// ("Invalid link", "Import failed") read by its wording as a warning, anything
// else ("Copied to clipboard") as a check.
const BLOCKSUITE_REFUSAL = /fail|invalid|can ?not|unable|error/i;
setToastHandler((message) =>
  userToast({
    title: toastText(message),
    variant: BLOCKSUITE_REFUSAL.test(message) ? 'warning' : 'success',
  })
);

// An image BlockSuite is about to store shows as a box on its board while it
// goes up (local change 70, boardUploads.ts).
setImageUploadHandler((std, file, xywh) =>
  boardUploads.get(std)?.begin(file, xywh)
);

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
  MindmapStoreExtension,
  PictureStoreExtension,
  CardsStoreExtension,
]);
/** AFFiNE's inline LaTeX specs, which note paragraphs need to render, without its
 * LaTeX node and editor menu: the board keeps `$$` as text, and those two load KaTeX
 * and shiki with the board. KaTeX loads with the first formula card instead. */
class InlineLatexViewExtension extends ViewExtensionProvider {
  override name = 'affine-latex-inline';

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([LatexInlineSpecExtension, LatexEditorUnitSpecExtension]);
  }
}

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
  SlashMenuViewExtension,
  ToolbarViewExtension,
  ViewportOverlayViewExtension,
];
const views = new ViewExtensionManager(VIEWS);

/** AFFiNE's mind map without its own toolbar button: the workspace canvas places one
 * from Misc (Epo 2026-11-09). Its effects (custom elements) still run. */
class MindmapWithoutTool extends MindmapViewExtension {
  override setup(context: ViewExtensionContext) {
    ViewExtensionProvider.prototype.setup.call(this, context);
    context.register([
      MindmapElementRendererExtension,
      MindmapDomRendererExtension,
      mindmapToolbarExtension,
      shapeMindmapToolbarExtension,
      MindMapView,
      MindMapDragExtension,
      MindMapIndicatorOverlay,
      MindMapInteraction,
    ]);
  }
}
/** The workspace canvas's: the question board's and what only it may hold. */
const workspaceViews = new ViewExtensionManager([...VIEWS, MindmapWithoutTool]);
/** A teacher's view: pan and zoom, with no tools or selection toolbar. */
const READ_ONLY_TOOLS = new Set<unknown>([
  EdgelessAutoConnectViewExtension,
  EdgelessDraggingAreaViewExtension,
  EdgelessSelectedRectViewExtension,
  EdgelessToolbarViewExtension,
  SlashMenuViewExtension,
  ToolbarViewExtension,
]);
const readOnlyViews = new ViewExtensionManager(
  VIEWS.filter((view) => !READ_ONLY_TOOLS.has(view))
);
/** A viewer's workspace canvas still draws what only it may hold, and selects
 * to copy: its selection's frame and box (boardReadOnly.ts). */
const READ_ONLY_SELECTS = new Set<unknown>([
  EdgelessDraggingAreaViewExtension,
  EdgelessSelectedRectViewExtension,
]);
const readOnlyWorkspaceViews = new ViewExtensionManager([
  ...VIEWS.filter(
    (view) => !READ_ONLY_TOOLS.has(view) || READ_ONLY_SELECTS.has(view)
  ),
  MindmapWithoutTool,
]);

const PHONE_WIDTH = 768;

// AFFiNE's dark palette under the app's dark themes: they set data-theme to a
// Catppuccin flavour, which AFFiNE's own [data-theme=dark] never matches. On
// <html>, so its popovers outside the board take it too; data-board-light lifts
// it while the marking image is drawn.
// AFFiNE's own dark placeholders and hairlines nearly vanish on its panels
// (rgb(62, 62, 63) on rgb(30, 30, 30)): lifted to readable greys.
const darkPalette = document.createElement('style');
darkPalette.textContent = `html.dark:not([data-board-light]){${Object.entries({
  ...combinedDarkCssVariables,
  '--affine-border-color': 'rgb(64, 64, 68)',
  '--affine-placeholder-color': 'rgb(138, 138, 145)',
})
  .map(([name, value]) => `${name}:${value}`)
  .join(';')}}`;
document.head.append(darkPalette);

/** The board has no frames, but resizing a selection clears their highlight. */
class NoFrameOverlay extends Overlay {
  static override overlayName = 'frame';
  override clear() {}
  override render() {}
}

const surfaceOf = (gfx: GfxController) =>
  gfx.surfaceComponent as SurfaceBlockComponent | null;

/** The plane card the dev pages start with. */
const FIRST_PLANE = { h: 520, ppu: 41, w: 820 };
/** A downloaded image's longest side in pixels: sharp on a screen, and well
 * inside every browser's canvas limit. */
const DOWNLOAD_SIDE_MAX = 4096;
/** The marking image's bytes after the shared compressor. */
const IMAGE_BYTES_MAX = 300 * 1024;

export type DrawingBoardOptions = {
  /** A dashed box with this label marks where to answer, and the first view fits it
   * (Epo 2026-11-07, W3/W4). Only on screen: the image, save, span and previews leave
   * it out, and a read-only board draws none. */
  answerArea?: { label: string };
  /** Room the first fit leaves around the drawing, [top, right, bottom, left] in
   * pixels, for what the page lays over the board (a pinned question, a top bar).
   * Without it, room for the board's own toolbar and undo. */
  fitPadding?: [number, number, number, number];
  /** The board's name now (a canvas's title), for the file Download as image
   * saves; without it, `canvas.png` or `drawing.png`. */
  title?: () => string;
  onChange?: () => void;
  /** Where its image files come from and go: none keeps them on the page only. */
  images?: BoardImages;
  /** Shows a plane card in the page's graph editor; a board that can be edited
   * needs it. */
  openPlane?: PlaneOpener;
  /** A fresh board starts with a plane card: the dev pages. Every answer starts on the
   * same plain board (Epo 2026-11-06). */
  plane?: boolean;
  /** No tools, nothing opens for editing: pan and zoom, and on a canvas
   * select and copy (boardReadOnly.ts). */
  readOnly?: boolean;
  /** An editor's board that takes no edits as it mounts (`setLocked`). */
  locked?: boolean;
  /** The view the board opens at, in place of the first fit: the one its
   * person had on this canvas a moment ago (`view()`). */
  view?: BoardView;
  /** Without `view`, the one this device kept for the canvas from an earlier
   * open (Q32): taken while anything on the board lies inside it, else the
   * first fit, as a peer may have moved or removed what was there (Epo
   * 2026-11-19, Q35). */
  kept?: BoardView;
  /** A question's answer board or the workspace canvas: what it may hold and its
   * tools (the board catalog). */
  board: BoardKind;
  /** The workspace canvas's quizzes and sets for its cards, and opening one. */
  workspace?: WorkspaceLinks;
  /** `save()`'s `doc`. A board that doesn't check out throws a BoardLoadError. */
  saved?: string;
  /** A canvas's room document, synced: the board edits it in place, and makes
   * no page or canvas of its own (the room's first state holds them). Without
   * it the board is in memory, opened from `saved`: answers and samples. */
  room?: { doc: Y.Doc };
  /** A plane's or chart's full-board editor opened (its card's id) or closed
   * (null), for the page's URL. */
  onEditor?: (cardId: string | null) => void;
};

export { BoardLoadError } from './boardLoad';

/** Where a board is looked at: its centre in board units, and its zoom. */
export type BoardView = { centre: [number, number]; zoom: number };

/** The answer area in board units; drawing inside it keeps span under the wide-board
 * warning's 2,000. */
const AREA = new Bound(0, 0, 1920, 1200);

/** The answer area's dashed box and label for the moving layer, kept the same size
 * on screen at every zoom by `zoom`. */
function answerArea(label: string) {
  const svg = 'http://www.w3.org/2000/svg';
  const box = document.createElementNS(svg, 'svg');
  box.style.cssText =
    'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible';
  const rect = document.createElementNS(svg, 'rect');
  rect.setAttribute('width', String(AREA.w));
  rect.setAttribute('height', String(AREA.h));
  rect.setAttribute('fill', 'none');
  rect.setAttribute('stroke', '#9aa0a6');
  box.append(rect);
  const chip = document.createElement('div');
  chip.className = 'capy-answer-area';
  chip.textContent = label;
  chip.style.cssText =
    'position:absolute;left:0;top:0;transform-origin:0 0;white-space:nowrap;height:20px;padding:0 7px;border-radius:4px 4px 4px 0;background:#222;color:#fff;font:600 12px/20px var(--affine-font-family)';
  return {
    box,
    chip,
    zoom: (zoom: number) => {
      rect.setAttribute('stroke-width', String(1.5 / zoom));
      rect.setAttribute('stroke-dasharray', `${8 / zoom} ${6 / zoom}`);
      // Its bottom left on the box's top left corner.
      chip.style.transform = `scale(${1 / zoom}) translateY(-100%)`;
    },
  };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An image block whose file cannot load, in a downloaded image: a light box
 * at its place saying so (Epo 2026-11-20, Q43). */
function missingImage(
  ctx: CanvasRenderingContext2D,
  [x, y, w, h]: readonly [number, number, number, number],
  scale: number
) {
  ctx.save();
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.lineWidth = scale;
  ctx.strokeRect(x + scale / 2, y + scale / 2, w - scale, h - scale);
  ctx.fillStyle = '#5c5c5c';
  ctx.font = `500 ${14 * scale}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(m.drawing_board_image_unavailable(), x + w / 2, y + h / 2, w);
  ctx.restore();
}

/** A pasted image drawn as the page draws it: an SVG too, which createImageBitmap
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

/** A copied image pasted on a canvas (in place of BlockSuite's own config):
 * another canvas's image is stored as this one's before its block is added,
 * under the stored id (`BoardBlobSource.pasted`). A board that went away
 * meanwhile, or an image that could not be stored, adds nothing. */
class BoardImageClipboard extends EdgelessClipboardConfig {
  static override readonly key = 'affine:image';

  static override setup(
    di: Parameters<typeof EdgelessClipboardConfig.setup>[0]
  ) {
    di.override(
      EdgelessClipboardConfigIdentifier(BoardImageClipboard.key),
      BoardImageClipboard,
      [StdIdentifier]
    );
  }

  override async createBlock(image: BlockSnapshot) {
    const { xywh, rotate, sourceId, size, width, height, caption } =
      image.props;
    const blobs = this.std.store.blobSync.main;
    if (!(blobs instanceof BoardBlobSource && typeof sourceId === 'string'))
      return null;
    const stored = await blobs.pasted(sourceId);
    if (!(stored && this.surface)) return null;
    return this.crud.addBlock(
      'affine:image',
      {
        caption,
        height,
        rotate,
        size: stored.bytes ?? size,
        sourceId: stored.id,
        width,
        xywh,
      },
      this.surface.model.id
    );
  }
}

/** The picture types BlockSuite's page paste takes as image blocks. */
const PASTED_IMAGE_TYPES = [
  'image/apng',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
];

/** A picture file pasted while something on the canvas is being edited (a
 * note's text) goes through BlockSuite's page paste, whose own adapter adds
 * the block first and stores its file after. On a canvas it is stored first,
 * as every other way in is: its block comes with a file that is stored, or
 * not at all (`imageAdds` gives it the stored id as it lands). */
function storedImagePaste(store: Store): ExtensionType {
  class StoredImagePaste extends ImageAdapter {
    override async toSliceSnapshot({
      file: files,
      pageId,
      workspaceId,
    }: Parameters<ImageAdapter['toSliceSnapshot']>[0]) {
      if (files.length === 0) return null;
      const content: SliceSnapshot['content'] = [];
      for (const file of files)
        content.push({
          children: [],
          flavour: 'affine:image',
          id: nanoid(),
          props: { size: file.size, sourceId: await store.blobSync.set(file) },
          type: 'block',
        });
      return { content, pageId, type: 'slice' as const, workspaceId };
    }
  }
  return {
    setup: (di) => {
      for (const mimeType of PASTED_IMAGE_TYPES)
        di.override(ClipboardAdapterConfigIdentifier(mimeType), () => ({
          adapter: StoredImagePaste,
          mimeType,
          priority: 80,
        }));
    },
  };
}

/** A store over a canvas's room document (roomStore.ts). BlockSuite's own
 * awareness (its selections) stays on this page: the room's carries only the
 * board's presence fields. */
function roomBoardStore(
  doc: Y.Doc,
  blobs: BoardBlobSource,
  storeExtensions: ExtensionType[],
  readonly: boolean
) {
  const awareness = new Awareness(doc);
  const opened = openRoomStore({
    awareness,
    blobs: { main: blobs },
    doc,
    id: 'board',
    readonly,
    storeExtensions,
  });
  return {
    close: () => {
      opened.dispose();
      awareness.destroy();
    },
    store: opened.store,
  };
}

/** A store on an in-memory board, opened from a saved answer when there is one. */
function memoryBoardStore(
  saved: Uint8Array | null,
  blobs: BoardBlobSource,
  storeExtensions: ExtensionType[]
) {
  const workspace = new TestWorkspace({ blobSources: { main: blobs } });
  workspace.storeExtensions = storeExtensions;
  workspace.meta.initialize();
  const store = workspace.createDoc('board').getStore();
  if (saved) {
    Y.applyUpdate(store.spaceDoc, saved);
    store.load();
  } else {
    store.load(() => {
      const page = store.addBlock('affine:page', { title: new Text() });
      store.addBlock('affine:surface', {}, page);
    });
  }
  return { close: null, store };
}

/** BlockSuite's edgeless editor on an in-memory board, opened from a saved answer when
 * there is one, or on a canvas's room document (`room`). */
export function mountDrawingBoard(
  container: HTMLElement,
  options: DrawingBoardOptions
) {
  const saved = options.saved ? fromBase64(options.saved) : null;
  // A question's board that doesn't check out is refused here. A canvas opens with
  // what doesn't fit drawn as placeholders (boardUnknown.ts).
  const misfits = saved ? checkSavedBoard(saved, options.board).misfits : [];
  if (misfits.length)
    console.warn('drawing board: shown as placeholders', misfits);
  // A view-only board mounts without tools for good; an editor's has them, and
  // takes no edits while it is locked.
  const tools = !options.readOnly;
  let readOnly = !tools || !!options.locked;
  const blobs = new BoardBlobSource(options.images);
  blobs.readonly = readOnly;
  const storeExtensions = [
    ...stores.get('store'),
    ...unknownStore(options.board),
  ];
  const { close: closeStore, store } = options.room
    ? roomBoardStore(options.room.doc, blobs, storeExtensions, readOnly)
    : memoryBoardStore(saved, blobs, storeExtensions);
  store.resetHistory();
  store.readonly = readOnly;
  // Its person's own changes to notes, a first note's creation too, count as
  // editing for the note's size (vendor/blocksuite local change 75).
  openNoteSizes(store);
  const { onChange } = options;
  if (onChange) store.spaceDoc.on('update', onChange);
  const imageBlocks = () =>
    store.getModelsByFlavour('affine:image') as ImageBlockModel[];
  // A new image is stored before BlockSuite adds its block (boardBlobs.ts),
  // which lands under BlockSuite's hash of the file: this tab's own block takes
  // the stored id as it lands, which is no step to undo. Another person's block
  // is theirs to place: this tab stores nothing for it and never removes it.
  const imageAdds = store.slots.blockUpdated.subscribe((change) => {
    if (change.type !== 'add' || change.flavour !== 'affine:image') return;
    if (!change.isLocal) return;
    const model = store.getModelById(change.id) as ImageBlockModel | null;
    const to = model?.props.sourceId && blobs.storedAs(model.props.sourceId);
    if (model && to)
      store.withoutTransact(() =>
        store.updateBlock(model, { size: to.bytes, sourceId: to.id })
      );
  });
  const drawn = [
    ...formulaExtensions,
    ...planeExtensions,
    ...chartExtensions,
    ...unknownViews,
    NoFrameOverlay,
  ];
  const std = new BlockStdScope({
    extensions: tools
      ? [
          ...(options.board === 'workspace'
            ? [
                ...workspaceViews.get('edgeless'),
                ...pictureViews,
                ...cardViews,
                BoardImageClipboard,
                storedImagePaste(store),
                TapPanTool,
              ]
            : views.get('edgeless')),
          shapeButtonTool,
          noteButtonTool,
          ...sheetTools(options.board),
          StampTool,
          ...drawn,
          noLatexMarkdown,
          ...boardToolbar,
        ]
      : [
          ...(options.board === 'workspace'
            ? [
                ...readOnlyWorkspaceViews.get('edgeless'),
                ...pictureViews,
                ...cardViews,
                TapPanTool,
              ]
            : readOnlyViews.get('edgeless')),
          ...drawn,
        ],
    store,
  });
  markBoard(std, options.board, !options.images?.none);
  if (options.workspace) lendWorkspace(std, options.workspace);
  // The board is one element of its own in the container, which goes with it:
  // whatever else its page keeps there (a loader, its cards) is never touched.
  // It goes in first, so a loader still there for a moment never has it laid
  // out lower than it will stand (BlockSuite keeps the place it measured).
  // What BlockSuite draws in it ends at `drawnEnd`; what goes in after that
  // (the menu, the page's presence layer) is removed by whoever put it there.
  const board = document.createElement('div');
  board.className = 'affine-edgeless-viewport capy-board';
  const drawnEnd = board.appendChild(document.createComment(''));
  container.prepend(board);
  render(std.render(), board, { renderBefore: drawnEnd });
  // An editor open as the room renames the early edits keeps its Undo and
  // caret (Q38).
  const unfollow = options.room
    ? followTextEditors(board, options.room.doc)
    : null;
  const gfx = std.get(GfxControllerIdentifier);
  if (options.openPlane) setPlaneOpener(gfx, options.openPlane);
  const unguard = tools
    ? keepToCatalog(store, gfx.surface, options.board)
    : null;
  // Top right, left of any Done the page puts there: undo, redo and zoom, so the
  // bottom row holds only the toolbar (Epo 2026-11-08). A teacher's has zoom only.
  const zoomTo = (zoom: number) =>
    gfx.viewport.smoothZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)));
  // The room's size and cap (`setRoomSize`): the menu's last row from 75% of the
  // cap, as a note's size line reads it (Epo 2026-11-18, 2B), and from the cap
  // less the room's margin (`BOARD_OFFLINE_MARGIN`, online too: client-limits
  // A) the board takes only removals and the row says so in the error colour.
  let roomSize: { bytes: number; max: number } | null = null;
  const fullAt = (size: { bytes: number; max: number } | null) =>
    !!size && size.bytes >= size.max - BOARD_OFFLINE_MARGIN;
  const sizeNote = () => {
    if (!roomSize || roomSize.bytes < roomSize.max * 0.75) return;
    const text = m.editor_stats_size({
      current: contentSizeKilobytes(roomSize.bytes).toLocaleString(),
      max: contentSizeKilobytes(roomSize.max).toLocaleString(),
    });
    const full = fullAt(roomSize);
    return {
      error: full,
      text: full ? `${text} · ${m.editor_limit_remove_only()}` : text,
    };
  };
  const menu = new BoardMenu(() => ({
    entries: [
      ...(readOnly
        ? []
        : [
            // A card being edited takes them: its quiz's or set's own history
            // (Epo 2026-11-13).
            {
              disabled: !(cardUndo()?.canUndo() ?? store.canUndo),
              icon: Undo03Icon,
              keepsOpen: true,
              label: m.drawing_board_undo(),
              run: () => (cardUndo() ?? store).undo(),
            },
            {
              disabled: !(cardUndo()?.canRedo() ?? store.canRedo),
              icon: Redo03Icon,
              keepsOpen: true,
              label: m.drawing_board_redo(),
              run: () => (cardUndo() ?? store).redo(),
            },
          ]),
      { label: m.drawing_board_fit_to_screen(), run: () => gfx.fitToScreen() },
      // Kept on a read-only board, as Office keeps Download.
      {
        disabled: !gfx.gfxElements.length,
        icon: Download01Icon,
        label: m.drawing_board_download_image(),
        run: () => void downloadImage(),
      },
      // Everything on the canvas goes in one undo step (Epo 2026-11-13).
      ...(readOnly
        ? []
        : [
            {
              disabled: !gfx.gfxElements.length,
              icon: Delete02Icon,
              label: m.drawing_board_clear_all(),
              run: () => {
                const crud = gfx.std.get(EdgelessCRUDIdentifier);
                gfx.selection.clear();
                store.captureSync();
                for (const element of [...gfx.gfxElements])
                  crud.removeElement(element.id);
                store.captureSync();
              },
            },
          ]),
    ],
    note: sizeNote(),
    zoom: {
      in: () => zoomTo(gfx.viewport.zoom + ZOOM_STEP),
      out: () => zoomTo(gfx.viewport.zoom - ZOOM_STEP),
      percent: { reset: () => zoomTo(1), value: () => gfx.viewport.zoom },
    },
  }));
  // A canvas near its room's cap (`fullAt`) takes only edits that remove
  // content: select, the eraser, delete and moving stay; a tool that adds, a
  // paste, a drop, ⌘D and Duplicate (`duplicates`), an Alt-drag's copy, a
  // mind map's Tab or Enter child, a shape's auto-complete +, a double
  // click's note, a piece, a picture, an image and a formula are refused with
  // the cap's line (boardFull.ts). Typing in what is there and Undo are not
  // stopped; a refusal by the room still goes to the copy-only recovery.
  let full = false;
  const ADDS_NOTHING = new Set([
    DefaultTool.toolName,
    'eraser',
    PanTool.toolName,
    TapPanTool.toolName,
  ]);
  /** Back to select from a tool that adds, while gated: said when the
   * person picked it, silent when the gate came on under it (the size row
   * says why), and never under a stroke in progress, which ends first. */
  let stillTool: (() => void) | null = null;
  const refuseTool = (picked: boolean) => {
    if (!full || ADDS_NOTHING.has(gfx.tool.currentToolName$.peek())) return;
    if (picked) {
      gfx.tool.setTool(DefaultTool);
      refusesAdds(store);
      return;
    }
    stillTool?.();
    stillTool = gfx.tool.dragging$.subscribe((dragging) => {
      if (dragging) return;
      queueMicrotask(() => {
        stillTool?.();
        stillTool = null;
        if (full && !ADDS_NOTHING.has(gfx.tool.currentToolName$.peek()))
          gfx.tool.setTool(DefaultTool);
      });
    });
  };
  /** A mind map's node alone is selected: Tab and Enter add its child or
   * sibling. */
  const onMindmapNode = () => {
    const { selectedElements, editing } = gfx.selection;
    return (
      !editing &&
      selectedElements.length === 1 &&
      selectedElements[0].group instanceof MindmapElementModel
    );
  };
  const refuseAdd = (event: Event) => {
    if (!full || readOnly) return;
    const adds =
      event.type === 'paste' ||
      event.type === 'drop' ||
      (event instanceof KeyboardEvent &&
        (((event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'd') ||
          ((event.key === 'Tab' || event.key === 'Enter') &&
            onMindmapNode()))) ||
      (event instanceof PointerEvent &&
        (event.altKey ||
          event
            .composedPath()
            .some(
              (target) =>
                target instanceof Element &&
                target.localName === 'edgeless-auto-complete'
            )));
    if (!adds) return;
    event.preventDefault();
    event.stopPropagation();
    refusesAdds(store);
  };
  for (const type of ['paste', 'drop', 'keydown', 'pointerdown'])
    board.addEventListener(type, refuseAdd, true);
  // Duplicate (the element toolbar's, ⌘D's) and a paste of copied elements
  // make their copies through one command.
  const { command } = std;
  const exec = command.exec.bind(command);
  command.exec = ((run, ...rest) =>
    (run as unknown) === createElementsFromClipboardDataCommand &&
    refusesAdds(store)
      ? [false, {}]
      : exec(run, ...rest)) as typeof command.exec;
  // The stylesheet shows the eraser's ring while it's the tool.
  const unwatchTool = gfx.tool.currentToolName$.subscribe((name) => {
    board.dataset.tool = name;
    if (full) queueMicrotask(() => refuseTool(true));
  });
  // The ☰ and, just left of it, the page's save status (`statusSlot`, empty
  // without a room).
  const chrome = document.createElement('div');
  chrome.className = 'capy-board-menu';
  const statusSlot = document.createElement('div');
  statusSlot.className = 'capy-board-status';
  chrome.append(statusSlot, menu.element);
  board.append(chrome);
  // Images going up: only a board that stores them at once (a canvas).
  const uploads = options.images?.store
    ? new BoardUploads(gfx, () => readOnly)
    : null;
  if (uploads) {
    boardUploads.set(std, uploads);
    blobs.onProgress = (file, percent) => uploads.progress(file, percent);
    chrome.before(uploads.element);
  }
  // A canvas that takes no edits selects and copies; an answer shown to its
  // teacher pans and zooms only.
  const copying =
    options.board === 'workspace'
      ? readOnlyCopy(gfx, board, () => readOnly)
      : null;
  if (copying) chrome.before(copying.bar);
  /** The tool a board that takes no edits starts on: a canvas's selects
   * (by a finger's tap on a touch screen), anything else's pans, as
   * BlockSuite's root picks when it mounts. */
  const readingTool = () => {
    if (!copying) gfx.tool.setTool(PanTool, { panning: true });
    else if (matchMedia('(pointer: coarse)').matches)
      gfx.tool.setTool(TapPanTool);
    else gfx.tool.setTool(DefaultTool);
  };
  const historyUpdates = store
    .get(HistoryExtension)
    .onUpdated.subscribe(() => menu.open && menu.draw());
  const zoomUpdates = gfx.viewport.viewportUpdated.subscribe(
    () => menu.open && menu.draw()
  );
  // The slots' keys (their tooltips show them): a card in the view's middle. Off while
  // typing anywhere, while a card is open (it takes the keys), and out of sight.
  const slotKeys = (event: KeyboardEvent) => {
    if (readOnly || full || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (!board.checkVisibility() || board.hasAttribute('data-editor-open'))
      return;
    const [target] = event.composedPath();
    if (
      target instanceof Element &&
      target.closest('input, textarea, [contenteditable="true"], math-field')
    )
      return;
    const centre: Vec = [gfx.viewport.centerX, gfx.viewport.centerY];
    const piece = {
      KeyB: event.shiftKey ? 'pie' : 'bar',
      KeyG: event.shiftKey ? 'polar' : 'cart',
    }[event.code] as 'pie' | 'bar' | 'polar' | 'cart' | undefined;
    if (piece) placePiece(gfx, piece, centre);
    else if (event.code === 'KeyM' && !event.shiftKey) openBlankFormula(gfx);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener('keydown', slotKeys);
  // While a card is edited, ⌘Z and ⇧⌘Z (Ctrl+Y) on the board reach its quiz's or
  // set's history, not the canvas's (Epo 2026-11-13). A field keeps its own undo,
  // and a dialog over the page (a question's) its own.
  const cardKeys = (event: KeyboardEvent) => {
    const history = cardUndo();
    if (!history || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const redo = key === 'y' || (key === 'z' && event.shiftKey);
    if (!redo && key !== 'z') return;
    const path = event.composedPath();
    const [target] = path;
    const onBoard = target === document.body || path.includes(board);
    if (
      !onBoard ||
      (target instanceof Element &&
        target.closest('input, textarea, [contenteditable="true"], math-field'))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (redo) history.redo();
    else history.undo();
    if (menu.open) menu.draw();
  };
  window.addEventListener('keydown', cardKeys, true);
  const unwatchEditor = options.onEditor
    ? watchBoardEditor(gfx, options.onEditor)
    : null;
  // A double click on empty canvas: a canvas text label on an answer board, with
  // its maths symbol row and fonts; an inline note on the workspace canvas, which
  // takes links, lists and bold (Epo 2026-11-13; local change 59).
  store.get(FeatureFlagService).setFlag('enable_edgeless_text', false);
  store
    .get(FeatureFlagService)
    .setFlag('enable_dblclick_note', options.board === 'workspace');
  store.get(FeatureFlagService).setFlag('enable_note_menu_media', false);
  outlineNewShapes(gfx);
  // The canvas draws in the app's light or dark (the dark class ThemeProvider sets).
  const root = document.documentElement;
  const theme$ = std.get(ThemeProvider).app$;
  const followTheme = () => {
    theme$.value = root.classList.contains('dark')
      ? ColorScheme.Dark
      : ColorScheme.Light;
  };
  followTheme();
  const themeWatch = new MutationObserver(followTheme);
  themeWatch.observe(root, { attributeFilter: ['class'] });
  // Canvas labels measure and draw in the stylesheet's faces, which load when first
  // used: the canvas draws a fallback until then, so it is drawn again once one has.
  const redrawOnFont = () => surfaceOf(gfx)?.refresh();
  document.fonts.addEventListener('loadingdone', redrawOnFont);
  void document.fonts.load('24px "blocksuite:surface:Inter"');
  const symbols = tools ? mountSymbolRow(gfx) : null;
  if (symbols) board.append(symbols.element);
  const unwatchLinks = watchNoteLinks(gfx, board);
  // A card's toolbar reads who may edit it and which card is edited, which the page
  // learns after the card is selected: the selection is set again so its toolbar
  // follows (Edit appears, Edit turns to Done).
  const unwatchCards = onCardState(() => {
    const { selection } = gfx;
    const elements = [...selection.selectedIds];
    if (elements.length !== 1 || selection.editing) return;
    if (store.getBlock(elements[0])?.flavour !== MATERIAL_FLAVOUR) return;
    selection.clear();
    selection.set({ editing: false, elements });
  });

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
    area?.zoom(gfx.viewport.zoom);
  };
  const area = tools
    ? options.answerArea && answerArea(options.answerArea.label)
    : null;
  if (area) {
    preview.before(area.box);
    layer.append(area.chip);
  }
  const subscription = gfx.viewport.viewportUpdated.subscribe(place);
  const everything = () => {
    const elements = gfx.layer.canvasElements;
    const blocks = gfx.layer.blocks;
    return (
      getCommonBound([...elements, ...blocks]) ?? new Bound(0, 0, 820, 520)
    );
  };
  /** What the image draws: everything, a quiz drawing's far groups drawn nearer
   * (FAR_GAP) on the marking image, with an 8-unit margin. `bound` is in board
   * units. */
  const framing = (nearer = true) => {
    const items = [...gfx.layer.canvasElements, ...gfx.layer.blocks];
    // Turned items by the box they turn into.
    const bounds = items.map((item) => item.elementBound);
    const whole = everything();
    // A quiz's drawing only (Epo 2026-11-18): a workspace canvas has no
    // answer area to keep the rest near.
    const far =
      nearer &&
      options.board === 'question' &&
      Math.max(whole.w, whole.h) > IMAGE_SIDE_MAX;
    const shifts = far ? closeUp(bounds) : bounds.map(() => ({ dx: 0, dy: 0 }));
    const placed = bounds.map(
      (box, i) =>
        new Bound(box.x - shifts[i].dx, box.y - shifts[i].dy, box.w, box.h)
    );
    const all = getCommonBound(placed) ?? whole;
    return {
      bound: new Bound(all.x - 8, all.y - 8, all.w + 16, all.h + 16),
      shiftOf: new Map(items.map((item, i) => [item.id, shifts[i]])),
    };
  };
  let room = options.fitPadding;
  let fitted = false;
  /** The first view: the answer area and what's drawn, or everything. */
  const fitView = () => {
    const drawn = getCommonBound([
      ...gfx.layer.canvasElements,
      ...gfx.layer.blocks,
    ]);
    gfx.viewport.setViewportByBound(
      area
        ? (getCommonBound([AREA, ...(drawn ? [drawn] : [])]) ?? AREA)
        : everything(),
      room ??
        (gfx.viewport.width < PHONE_WIDTH
          ? [64, 12, 96, 12]
          : [90, 40, 130, 40])
    );
    // Never opened larger than life: a small drawing (one note) fitted to the
    // screen came up at 200% and more (Epo 2026-11-13).
    if (gfx.viewport.zoom > 1) gfx.viewport.setZoom(1);
    place();
    fitted = true;
  };
  /** Whether anything on the board lies inside `view` on this screen. */
  const shows = ({ centre: [x, y], zoom }: BoardView) => {
    const { height, width } = gfx.viewport;
    const seen = new Bound(
      x - width / zoom / 2,
      y - height / zoom / 2,
      width / zoom,
      height / zoom
    );
    return [...gfx.layer.canvasElements, ...gfx.layer.blocks].some((item) =>
      item.elementBound.isOverlapWithBound(seen)
    );
  };
  // Resolved once the board first shows, its first view set.
  let shown!: () => void;
  const ready = new Promise<void>((resolve) => {
    shown = resolve;
  });
  let frame = requestAnimationFrame(function mountLayer() {
    const background = container.querySelector('.edgeless-background');
    if (!background || !gfx.viewport.width) {
      frame = requestAnimationFrame(mountLayer);
      return;
    }
    background.prepend(layer);
    if (readOnly && copying) readingTool();
    if (options.plane && !saved) {
      addPlane(
        gfx,
        new Bound(0, 0, FIRST_PLANE.w, FIRST_PLANE.h),
        FIRST_PLANE.ppu,
        false
      );
      store.resetHistory();
    }
    const { kept, view } = options;
    const opening = view ?? (kept && shows(kept) ? kept : undefined);
    if (opening) {
      gfx.viewport.setViewport(opening.zoom, opening.centre);
      place();
      fitted = true;
    } else fitView();
    shown();
  });

  /** A pasted image from its file; a note card by html2canvas, as it's DOM. */
  const blockImage = async (block: GfxBlockElementModel) => {
    if (block instanceof ImageBlockModel) {
      const { sourceId } = block.props;
      const blob = sourceId && (await store.blobSync.get(sourceId));
      return blob ? decodeImage(blob) : null;
    }
    const view = std.view.getBlock(block.id);
    if (!view) return null;
    // Drawn in the palette toImage just switched to.
    await view.updateComplete;
    // A note out of view is BlockSuite's idle block: hidden with no size, which
    // html2canvas draws as nothing at all. It's shown for the capture only.
    const idle =
      isGfxBlockComponent(view) && view.transformState$.value === 'idle';
    if (idle) view.transformState$.value = 'active';
    try {
      return await std.get(ExportManager)._html2canvas(view);
    } finally {
      if (idle) view.transformState$.value = 'idle';
    }
  };

  // An open plane writes its view on closing, and nothing else is in progress.
  const finishPlot = () => {
    closeBoardEditor(gfx);
    gfx.tool.setTool(DefaultTool);
  };

  /** The board drawn layer by layer on white, its longest side at most `side`
   * pixels: the marking image (see toImage) draws far groups nearer, a download
   * draws the board as it lies. `missing`: an image whose file cannot load is a
   * box saying so (a download, Q43); the marking image leaves it out. */
  const drawImage = async (side: number, nearer: boolean, missing: boolean) => {
    await formulasDrawn(gfx);
    const renderer = surfaceOf(gfx)?.renderer;
    if (!(renderer instanceof CanvasRenderer))
      throw new Error('drawing board: no canvas renderer');
    const { bound, shiftOf } = framing(nearer);
    const scale = Math.min(2, side / Math.max(bound.w, bound.h));
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
          const from = new Bound(bound.x + dx, bound.y + dy, bound.w, bound.h);
          ctx.drawImage(
            // Card paper opaque, as previews draw it (cardPaper).
            asImage(() =>
              renderer.getCanvasByBound(
                from,
                elements,
                undefined,
                false,
                false,
                scale
              )
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
        else if (missing && block instanceof ImageBlockModel)
          missingImage(ctx, place, scale);
      }
    }
    const png = await new Promise<Blob | null>((resolve) =>
      output.toBlob(resolve, 'image/png')
    );
    if (!png) throw new Error('drawing board: no image');
    return png;
  };

  /** Drawn in the light palette, whatever the app's theme. */
  const lightImage = async (
    side: number,
    nearer: boolean,
    missing: boolean
  ) => {
    root.dataset.boardLight = '';
    theme$.value = ColorScheme.Light;
    try {
      return await drawImage(side, nearer, missing);
    } finally {
      delete root.dataset.boardLight;
      followTheme();
    }
  };

  /** The downloaded file's name: the board's title, with what a file name
   * cannot hold taken out; `canvas` or `drawing` without one. */
  const imageName = () =>
    options
      .title?.()
      .replace(/[\\/:*?"<>|]/g, '')
      .trim() || (options.board === 'workspace' ? 'canvas' : 'drawing');

  /** The menu's Download as image: the whole board as a PNG, read-only too. A
   * board that cannot be drawn says so. */
  const downloadImage = async () => {
    if (!readOnly) finishPlot();
    try {
      downloadBlob(
        await lightImage(DOWNLOAD_SIDE_MAX, false, true),
        `${imageName()}.png`
      );
    } catch (error) {
      console.error(error);
      userToast({ title: m.drawing_board_download_failed(), variant: 'error' });
    }
  };

  return {
    /** Leaves the open plane or chart, writing it as Done does. */
    closeEditor: () => closeBoardEditor(gfx),
    /** Saves a note's size waiting on a pause in typing, or drops it when the
     * room lost, refused or replaced the board, and stops every wait: nothing
     * more is measured or written (local change 75). For a host whose last
     * write, or whose document's end, comes before `unmount`. */
    closeNoteSizes: (sizes: 'save' | 'drop') => closeNoteSizes(store, sizes),
    /** The first view again, with this room around it: a board mounted ahead, shown
     * at the screen's width then (a tablet turned since). Before the first view, it
     * only sets that view's room. */
    fit: (padding: [number, number, number, number]) => {
      room = padding;
      if (fitted) fitView();
    },
    /** Whether the board holds `id`, a card or anything else drawn. */
    has: (id: string) => !!gfx.getElementById(id),
    /** The whole board as a PNG, as Download as image draws it. */
    image: () => lightImage(DOWNLOAD_SIDE_MAX, false, true),
    /** The same with every file the board can get, asking for the ones it
     * doesn't hold yet (a stored drawing's, not shown so far): what Done sends.
     * An image whose file is nowhere is left out, and stays an empty frame. */
    imageFiles: async () => {
      const ids = [
        ...new Set(imageBlocks().flatMap(({ props }) => props.sourceId ?? [])),
      ];
      const files = await Promise.all(ids.map((id) => blobs.get(id)));
      return ids.flatMap((id, i) => {
        const file = files[i];
        return file ? [{ file, id }] : [];
      });
    },
    /** The images on the board now, each id once, with the file the board holds
     * for it (none: stored elsewhere and not shown yet). */
    images: () =>
      [
        ...new Set(imageBlocks().flatMap(({ props }) => props.sourceId ?? [])),
      ].map((id) => ({ file: blobs.held(id), id })),
    /** Opens the full-board editor of the plane or chart card `id`: false when
     * the board has no such card (or opens nothing for editing). */
    openEditor: (id: string) => {
      const element = gfx.getElementById(id);
      if (element instanceof PlaneElementModel) openPlane(gfx, element);
      else if (element instanceof ChartElementModel) openChart(gfx, element);
      else return false;
      // A plane's editor (the page's, `.capy-graph-editor`) or a chart's.
      return !!board.querySelector('.capy-graph-editor, .capy-plane-editor');
    },
    /** What a canvas's presence reads of the board (boardPresenceView.ts): its
     * viewport, selection and text caret, and where others' marks go. */
    presence: boardPresenceView(std, gfx, board, uploads),
    /** Out of sight but kept mounted: an open card closes, nothing stays selected,
     * and the page's keys and pastes no longer reach it. */
    putAway: () => {
      finishPlot();
      gfx.selection.clear();
      std.selection.clear();
      std.event.deactivate();
    },
    /** Resolves once the board first shows (`image` draws it from then). */
    ready,
    /** Redraws the quiz and flashcard cards, and an open Misc panel's list of
     * them, after the workspace's list changes: the board may show before the
     * list has loaded. */
    refreshCards: () => {
      refreshMaterialCards();
      refreshMiscLists();
    },
    /** Brings `id` into view when it is out of it, so a card's runner mounts. */
    reveal: (id: string) => {
      const element = gfx.getElementById(id);
      if (!(element && 'elementBound' in element)) return;
      const bound = element.elementBound;
      if (!gfx.viewport.viewportBounds.contains(bound))
        gfx.viewport.setCenter(bound.center[0], bound.center[1]);
    },
    /** The board to store, with no undo history and rounded (savedCopy). */
    save: () => {
      finishPlot();
      // A note's size waiting on a pause in typing goes in (local change 75).
      saveNoteSizes(store);
      const update = savedCopy(store.spaceDoc, options.board);
      return { bytes: update.byteLength, doc: toBase64(update) };
    },
    /** Stops an editor's board taking edits, or lets it take them again, in
     * place: its view, its history and its tools stay mounted (a room that is
     * sending stored steps, offline past its bound, outdated or lost). An open
     * plane or chart is written as Done does before the board stops. A
     * view-only board (`readOnly`) has no tools to give back and stays as it
     * is. */
    setLocked: (locked: boolean) => {
      if (!tools || locked === readOnly) return;
      if (locked) {
        // Before a note's editing ends (the tool change, the selection's
        // clear) and saves its waiting size into a room just lost or refused
        // (local change 75).
        dropNoteSizes(store);
        finishPlot();
        gfx.selection.clear();
      }
      readOnly = locked;
      blobs.readonly = locked;
      store.readonly = locked;
      // Nothing measures a note again by itself: a size the lock dropped
      // would stay unwritten (local change 75).
      if (!locked) measureNoteSizesAgain(store);
      if (locked) readingTool();
      else gfx.tool.setTool(DefaultTool);
      if (menu.open) menu.draw();
      uploads?.changed();
      copying?.draw();
    },
    /** The room's size against its cap, shown in the menu from 75%; null (no
     * room) shows none. */
    setRoomSize: (size: { bytes: number; max: number } | null) => {
      // Called on every update of the room: only a change of what the board
      // shows or takes does any work.
      const before = menu.open ? JSON.stringify(sizeNote()) : '';
      roomSize = size;
      if (menu.open && JSON.stringify(sizeNote()) !== before) menu.draw();
      if (fullAt(size) === full) return;
      full = !full;
      setBoardFull(store, full);
      board.toggleAttribute('data-full', full);
      store
        .get(FeatureFlagService)
        .setFlag(
          'enable_dblclick_note',
          options.board === 'workspace' && !full
        );
      refuseTool(false);
    },
    /** The board as it is, leaving a tool in use alone; a note's size waiting
     * on a pause in typing goes in. */
    snapshot: () => {
      saveNoteSizes(store);
      return toBase64(Y.encodeStateAsUpdate(store.spaceDoc));
    },
    stats: () => {
      const { bound } = framing();
      return {
        blocks: gfx.layer.blocks.map((block) => block.flavour),
        bytes: Y.encodeStateAsUpdate(store.spaceDoc).byteLength,
        canvas: gfx.layer.canvasElements.map((element) => element.type),
        marks: planeMarks(gfx),
        /** The image's longest side in board units, for the wide-board warning on Done. */
        span: Math.max(bound.w, bound.h),
      };
    },
    /** Just left of the ☰ in the board's chrome, for the page's save status:
     * taking no room while empty. */
    statusSlot,
    /** The canvas as it stands, for marking, through the shared image compressor:
     * every card with the view it was left at, and what's drawn over and around them.
     * Something dragged far away is drawn nearer (FAR_GAP). */
    toImage: async () => {
      if (!readOnly) finishPlot();
      // Marked on white in the light palette, whatever the app's theme.
      const png = await lightImage(IMAGE_SIDE_MAX, true, false);
      // The encode runs in the compressor's worker; drawing needs the page.
      // Line art keeps its ink at 0.75: 10-20% smaller than the shared 0.85
      // (Epo 2026-11-06: minimise drawing storage).
      return fitImageOffThread(
        new File([png], 'drawing.png', { type: 'image/png' }),
        IMAGE_BYTES_MAX,
        { quality: 0.75 }
      );
    },
    /** `sizes`: a note's size waiting on a pause in typing is saved, or
     * dropped when the room lost, refused or replaced the board (local change
     * 75); every wait stops either way. */
    unmount: (sizes: 'save' | 'drop') => {
      // While `onChange` still hears it.
      closeNoteSizes(store, sizes);
      blobs.close();
      cancelAnimationFrame(frame);
      subscription.unsubscribe();
      historyUpdates.unsubscribe();
      zoomUpdates.unsubscribe();
      unwatchTool();
      unguard?.();
      imageAdds.unsubscribe();
      document.removeEventListener('keydown', slotKeys);
      for (const type of ['paste', 'drop', 'keydown', 'pointerdown'])
        board.removeEventListener(type, refuseAdd, true);
      window.removeEventListener('keydown', cardKeys, true);
      unwatchEditor?.();
      unfollow?.();
      menu.dispose();
      chrome.remove();
      uploads?.dispose();
      boardUploads.delete(std);
      stillTool?.();
      copying?.dispose();
      if (onChange) store.spaceDoc.off('update', onChange);
      symbols?.unmount();
      unwatchLinks();
      unwatchCards();
      themeWatch.disconnect();
      document.fonts.removeEventListener('loadingdone', redrawOnFont);
      closeBoardEditor(gfx);
      forgetFormulas();
      render(null, board, { renderBefore: drawnEnd });
      board.remove();
      closeStore?.();
    },
    /** Where the board is looked at now (`DrawingBoardOptions.view`); none
     * before its first view. */
    view: (): BoardView | null =>
      fitted
        ? {
            centre: [gfx.viewport.centerX, gfx.viewport.centerY],
            zoom: gfx.viewport.zoom,
          }
        : null,
  };
}
