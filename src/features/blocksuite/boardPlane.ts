import {
  type ElementRenderer,
  ElementRendererExtension,
  elementsCtorMap,
} from '@blocksuite/affine/blocks/surface';
import {
  Bound,
  getPointsFromBoundWithRotation,
  type IVec,
  linePolygonIntersects,
  pointInPolygon,
  polygonNearestPoint,
  type SerializedXYWH,
} from '@blocksuite/affine/global/gfx';
import {
  field,
  type GfxController,
  GfxElementModelView,
  GfxPrimitiveElementModel,
  GfxViewInteractionExtension,
  observe,
} from '@blocksuite/affine/std/gfx';
import * as Y from 'yjs';
import { drawGraph, textBox } from '@/features/graph/draw';
import { formulaBox } from '@/features/graph/formula';
import {
  type ElementEntry,
  keyedElements,
  readElements,
  writeElements,
} from '@/features/graph/keyed';
import type { Frame, Graph } from '@/features/graph/model';
import { bboxOf, type View } from '@/features/graph/view';
import {
  cardPaper,
  LABEL_SIZE,
  type Paper,
  type PlaneElement,
  pointsOf,
} from './boardData';
import { laidOut } from './boardFormulaDraw';
import type { Vec } from './boardGeometry';

/** The plane's top left corner in its own units, and board pixels per unit. A polar
 * plane draws rings and spokes round its origin instead of squares (Epo 2026-11-08). */
export type PlaneView = {
  polar?: boolean;
  ppu: number;
  x0: number;
  y0: number;
};

/** The engine's camera for a plane's view: one scale on both axes. */
export const viewOfPlane = ({ ppu, x0, y0 }: PlaneView): View => ({
  left: x0,
  ppuX: ppu,
  ppuY: ppu,
  top: y0,
});

const CARD_WIDTH_MIN = 120;
const CARD_HEIGHT_MIN = 80;
const CARD_SIDE_MAX = 4000;
/** Fit to size: the room left around the marks, and the longest side before it zooms
 * out instead of growing. */
const FIT_PAD = 40;
const FIT_SIDE_MAX = 1600;
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

/** A plane seen through `view` in `frame`, drawn by the graph engine as every graph
 * is (Epo 2026-11-16, D5/D14): always its grid and axes. */
export function drawPlane(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  view: PlaneView,
  elements: PlaneElement[],
  paper: Paper,
  /** Draws again once a formula on it is laid out. */
  refresh: () => void = () => undefined
) {
  const camera = viewOfPlane(view);
  const graph: Graph = {
    board: {
      axis: true,
      bbox: bboxOf(camera, frame.w, frame.h),
      grid: true,
      polar: Boolean(view.polar),
    },
    elements,
  };
  drawGraph(ctx, frame, camera, graph, paper, refresh);
}

/** A plane label's text box on screen, centred on (x, y), wrapped as it's drawn. */
export const labelBox = (
  ctx: CanvasRenderingContext2D,
  { size = LABEL_SIZE, text }: { size?: number; text: string },
  x: number,
  y: number
) => textBox(ctx, text, size, x, y);

/** The plane's elements as stored: one entry per element id, each the element and
 * its order key (Epo 2026-11-16, D10), kept as BlockSuite's mind map keeps its nodes. */
type Entries = Y.Map<ElementEntry<PlaneElement>>;

/** A change to the plane's elements reaches no field, so the plane says so itself:
 * the renderer and an open editor draw again. */
function observeElements(
  event: Y.YEvent<Entries> | null,
  plane: PlaneElementModel,
  transaction: Y.Transaction | null
) {
  plane.forgetList();
  if (!(event && transaction)) return;
  plane.surface.elementUpdated.next({
    id: plane.id,
    local: transaction.local,
    oldValues: {},
    props: { elements: plane.elements },
  });
}

export class PlaneElementModel extends GfxPrimitiveElementModel<{
  fit: boolean;
  elements: Entries;
  index: string;
  polar: boolean;
  ppu: number;
  rotate: number;
  seed: number;
  x0: number;
  xywh: SerializedXYWH;
  y0: number;
}> {
  get type() {
    return 'plane';
  }

  /** A pasted or new card's elements, plain (`keyedElements`) or as the clipboard
   * serialized them, become the stored map, as the mind map's nodes do. */
  static propsToY(props: Record<string, unknown>) {
    if (props.elements && !(props.elements instanceof Y.Map)) {
      const entries: Entries = new Y.Map();
      for (const [id, entry] of Object.entries(
        props.elements as Record<string, ElementEntry<PlaneElement>>
      ))
        entries.set(id, entry);
      props.elements = entries;
    }
    return props;
  }

  /** The elements in order, read once per change to the map. */
  #list: PlaneElement[] | null = null;
  get elementList() {
    this.#list ??= readElements(this.elements.entries());
    return this.#list;
  }
  forgetList() {
    this.#list = null;
  }
  /** Makes the plane hold `next`, writing only the elements that changed. */
  writeList(next: PlaneElement[]) {
    this.surface.store.transact(() => writeElements(this.elements, next));
  }

  /** A turned card (Epo 2026-11-13) answers by its turned corners, as a formula's. */
  override containsBound(bounds: Bound) {
    return getPointsFromBoundWithRotation(this).some((point) =>
      bounds.containsPoint(point)
    );
  }

  /** The eraser leaves a card alone: its marks are erased inside (vendored local
   * change 30). */
  get erasable() {
    return false;
  }

  /** Where a connector meets the card's edge. */
  override getLineIntersections(start: IVec, end: IVec) {
    return linePolygonIntersects(
      start,
      end,
      getPointsFromBoundWithRotation(this)
    );
  }

  override getNearestPoint(point: IVec) {
    return polygonNearestPoint(
      getPointsFromBoundWithRotation(this),
      point
    ) as IVec;
  }

  override includesPoint(x: number, y: number) {
    return pointInPolygon([x, y], getPointsFromBoundWithRotation(this));
  }

  /** Fit to size: the card follows its marks each time the plane is left. */
  @field()
  accessor fit = true;

  @observe(observeElements)
  @field()
  accessor elements: Entries = new Y.Map();

  @field()
  accessor polar = false;

  @field()
  accessor ppu = 41;

  @field(0)
  accessor rotate = 0;

  @field()
  accessor x0 = 0;

  @field()
  accessor xywh: SerializedXYWH = '[0,0,16,16]';

  @field()
  accessor y0 = 0;
}

// The surface builds its elements from this map when a board opens.
Object.assign(elementsCtorMap, { plane: PlaneElementModel });

const planeRenderer: ElementRenderer<PlaneElementModel> = (
  model,
  ctx,
  matrix,
  renderer
) => {
  const [, , w, h] = model.deserializedXYWH;
  // Turned round its middle, as a formula card is.
  ctx.setTransform(
    matrix
      .translateSelf(w / 2, h / 2)
      .rotateSelf(model.rotate)
      .translateSelf(-w / 2, -h / 2)
  );
  drawPlane(
    ctx,
    { h, w, x: 0, y: 0 },
    model,
    model.elementList,
    cardPaper(renderer.getColorScheme()),
    () => renderer.refresh()
  );
};

/** The full-screen editor, set by its module so this one stays light. */
let openEditor: (gfx: GfxController, model: PlaneElementModel) => void = () =>
  undefined;
export function setPlaneEditor(open: typeof openEditor) {
  openEditor = open;
}
export const openPlane = (gfx: GfxController, model: PlaneElementModel) =>
  openEditor(gfx, model);

/** Every point a plane's marks reach (a curve's handles too), and its origin, so the
 * axes stay in view. A function reaches none: it runs across whatever is shown. */
export function markPoints(marks: PlaneElement[]) {
  return [
    [0, 0] as Vec,
    ...marks.flatMap((mark) => [
      ...pointsOf(mark),
      ...(mark.type === 'curve' && mark.handles ? mark.handles.flat() : []),
    ]),
  ];
}

/** A point `dx` along and `dy` down a card turned `rotate` degrees, from `from`. */
const turned = (rotate: number, [x, y]: Vec, dx: number, dy: number): Vec => {
  const turn = (rotate * Math.PI) / 180;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  return [x + dx * cos - dy * sin, y + dx * sin + dy * cos];
};
const minus = ([ax, ay]: Vec, [bx, by]: Vec): Vec => [ax - bx, ay - by];

/** A canvas only for measuring text, made once. */
let measurer: CanvasRenderingContext2D | null = null;

/** How far each label's and formula's text reaches past its point, in pixels: as
 * much at any scale, so Fit to size keeps sized text on the card (Epo 2026-11-13). A
 * formula not laid out yet counts as its point. */
function textReach(marks: PlaneElement[]) {
  measurer ??= document.createElement('canvas').getContext('2d');
  return marks.flatMap((mark) => {
    if (mark.type === 'text' && measurer) {
      const { h, w } = labelBox(measurer, mark, 0, 0);
      return [{ at: mark.coords, x: w / 2, y: h / 2 }];
    }
    const drawn = mark.type === 'formula' && laidOut(mark.latex);
    if (!drawn || mark.type !== 'formula') return [];
    const { h, w } = formulaBox(drawn, 0, 0, mark.size);
    return [{ at: mark.coords, x: w / 2, y: h / 2 }];
  });
}

/** Sizes a card to its marks at its scale, its top left staying put. Past the longest
 * side it zooms out instead. An empty card keeps its size. Not in the undo history,
 * like the view. */
export function fitCard(model: PlaneElementModel) {
  const seen = markPoints(model.elementList);
  // Nothing but the origin (no marks, or only functions): the card keeps its size.
  if (seen.length < 2) return;
  const xs = seen.map(([x]) => x);
  const ys = seen.map(([, y]) => y);
  const room = FIT_SIDE_MAX - FIT_PAD * 2;
  const ppu = Math.min(
    model.ppu,
    room / Math.max(Math.max(...xs) - Math.min(...xs), 1e-6),
    room / Math.max(Math.max(...ys) - Math.min(...ys), 1e-6)
  );
  // The plane's pixels at that scale: the points, and the text round its own.
  const texts = textReach(model.elementList);
  const [left, right, bottom, top] = [
    Math.min(
      ...xs.map((x) => x * ppu),
      ...texts.map((t) => t.at[0] * ppu - t.x)
    ),
    Math.max(
      ...xs.map((x) => x * ppu),
      ...texts.map((t) => t.at[0] * ppu + t.x)
    ),
    Math.min(
      ...ys.map((y) => y * ppu),
      ...texts.map((t) => t.at[1] * ppu - t.y)
    ),
    Math.max(
      ...ys.map((y) => y * ppu),
      ...texts.map((t) => t.at[1] * ppu + t.y)
    ),
  ];
  const w = clamp(right - left + FIT_PAD * 2, CARD_WIDTH_MIN, FIT_SIDE_MAX);
  const h = clamp(top - bottom + FIT_PAD * 2, CARD_HEIGHT_MIN, FIT_SIDE_MAX);
  // Its top left corner stays put on the page, the card turned or not.
  const was = Bound.deserialize(model.xywh);
  const corner = turned(
    model.rotate,
    was.center as Vec,
    -was.w / 2,
    -was.h / 2
  );
  const [cx, cy] = turned(model.rotate, corner, w / 2, h / 2);
  model.surface.store.withoutTransact(() => {
    model.ppu = ppu;
    model.x0 = ((left + right) / 2 - w / 2) / ppu;
    model.y0 = ((top + bottom) / 2 + h / 2) / ppu;
    model.xywh = new Bound(cx - w / 2, cy - h / 2, w, h).serialize();
  });
}

class PlaneElementView extends GfxElementModelView<PlaneElementModel> {
  static override type = 'plane';

  override onCreated() {
    super.onCreated();
    this.on('dblclick', () => openEditor(this.gfx, this.model));
  }
}

/** Resizing shows more or less of the plane at the same scale: dragging the left or
 * top edge keeps what's on the plane where it is on the page. A card turns (Epo
 * 2026-11-13); turned, the side across from the dragged handle stays put on the page. */
const planeInteraction = GfxViewInteractionExtension<PlaneElementView>(
  'plane',
  {
    handleResize({ model }) {
      const { x0, y0 } = model;
      const start = Bound.deserialize(model.xywh);
      return {
        onResizeEnd(context) {
          context.default(context);
          model.pop('x0');
          model.pop('y0');
        },
        onResizeMove(context) {
          const { constraint, handle, newBound } = context;
          const w = clamp(newBound.w, constraint.minWidth, constraint.maxWidth);
          const h = clamp(
            newBound.h,
            constraint.minHeight,
            constraint.maxHeight
          );
          // BlockSuite's bound, for this card alone or as one of several (and with
          // Shift); at a limit, the side across from the handle stays put.
          const sx = handle.includes('left')
            ? 1
            : handle.includes('right')
              ? -1
              : 0;
          const sy = handle.includes('top')
            ? 1
            : handle.includes('bottom')
              ? -1
              : 0;
          const kept = turned(
            model.rotate,
            newBound.center as Vec,
            (sx * newBound.w) / 2,
            (sy * newBound.h) / 2
          );
          const centre = turned(
            model.rotate,
            kept,
            (-sx * w) / 2,
            (-sy * h) / 2
          );
          model.xywh = new Bound(
            centre[0] - w / 2,
            centre[1] - h / 2,
            w,
            h
          ).serialize();
          // What's on the plane stays on the page: the view follows the card's top
          // left corner, measured along the card's own turned sides.
          const [dx, dy] = minus(
            turned(model.rotate, centre, -w / 2, -h / 2),
            turned(
              model.rotate,
              start.center as Vec,
              -start.w / 2,
              -start.h / 2
            )
          );
          const [along, down] = turned(-model.rotate, [0, 0], dx, dy);
          model.x0 = x0 + along / model.ppu;
          model.y0 = y0 - down / model.ppu;
        },
        onResizeStart(context) {
          context.default(context);
          // As resizing a note does: the card keeps the size it's given.
          model.fit = false;
          model.stash('x0');
          model.stash('y0');
        },
      };
    },
    resizeConstraint: {
      maxHeight: CARD_SIDE_MAX,
      maxWidth: CARD_SIDE_MAX,
      minHeight: CARD_HEIGHT_MIN,
      minWidth: CARD_WIDTH_MIN,
    },
  }
);

export const planeExtensions = [
  ElementRendererExtension('plane', planeRenderer),
  PlaneElementView,
  planeInteraction,
];

/** A card on the canvas, its plane's origin towards the lower left, or in the middle
 * of a polar one. */
export function addPlane(
  gfx: GfxController,
  box: Bound,
  ppu: number,
  polar: boolean
) {
  return gfx.surface?.addElement({
    elements: keyedElements([]),
    fit: true,
    polar,
    ppu,
    type: 'plane',
    x0: polar ? -box.w / 2 / ppu : -1,
    xywh: box.serialize(),
    y0: (box.h * (polar ? 0.5 : 0.7)) / ppu,
  });
}

export function planeMarks(gfx: GfxController) {
  return gfx.layer.canvasElements
    .filter((element) => element.type === 'plane')
    .reduce(
      (count, element) =>
        count + (element as PlaneElementModel).elementList.length,
      0
    );
}
