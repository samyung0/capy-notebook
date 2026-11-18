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
import { drawGraph } from '@/features/graph/draw';
import { FIT_SIDE_MAX, fitMarks, fitWindow } from '@/features/graph/fit';
import {
  type ElementEntry,
  keyedElements,
  readElements,
  writeElements,
} from '@/features/graph/keyed';
import type { Frame, Graph, GraphElement } from '@/features/graph/model';
import { bboxOf, PLANE_ZOOM, type View } from '@/features/graph/view';
import { cardPaper, type Paper } from './boardData';
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
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

/** A plane seen through `view` in `frame`, drawn by the graph engine as every graph
 * is (Epo 2026-11-16, D5/D14): always its grid and axes. */
export function drawPlane(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  view: PlaneView,
  elements: GraphElement[],
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

/** The plane's elements as stored: one entry per element id, each the element and
 * its order key (Epo 2026-11-16, D10), kept as BlockSuite's mind map keeps its nodes.
 * A plane holds every kind a graph holds (D16): what its tools draw (points, lines
 * and vectors as `polyline`, curves with their handles, ellipses, labels and
 * formulas) and what its objects list types (functions, named points and the
 * constructions built on them). */
type Entries = Y.Map<ElementEntry<GraphElement>>;

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
        props.elements as Record<string, ElementEntry<GraphElement>>
      ))
        entries.set(id, entry);
      props.elements = entries;
    }
    return props;
  }

  /** The elements in order, read once per change to the map. */
  #list: GraphElement[] | null = null;
  get elementList() {
    this.#list ??= readElements(this.elements.entries());
    return this.#list;
  }
  forgetList() {
    this.#list = null;
  }
  /** Makes the plane hold `next`, writing only the elements that changed. */
  writeList(next: GraphElement[]) {
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

  /** Fit to size: the card follows its marks each time the plane is left.
   * A card starts at Custom size, the size it is placed at (Epo 2026-11-18). */
  @field()
  accessor fit = false;

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

/** A point `dx` along and `dy` down a card turned `rotate` degrees, from `from`. */
const turned = (rotate: number, [x, y]: Vec, dx: number, dy: number): Vec => {
  const turn = (rotate * Math.PI) / 180;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  return [x + dx * cos - dy * sin, y + dx * sin + dy * cos];
};
const minus = ([ax, ay]: Vec, [bx, by]: Vec): Vec => [ax - bx, ay - by];

/** Sizes a card to its marks at its scale, its top left staying put. Past the longest
 * side it zooms out instead. An empty card keeps its size. Not in the undo history,
 * like the view. */
export function fitCard(model: PlaneElementModel) {
  const was = Bound.deserialize(model.xywh);
  const fitted = fitMarks(
    model.elementList,
    { x: model.ppu, y: model.ppu },
    { max: FIT_SIDE_MAX, minH: CARD_HEIGHT_MIN, minW: CARD_WIDTH_MIN },
    {
      x: [model.x0, model.x0 + was.w / model.ppu],
      y: [model.y0 - was.h / model.ppu, model.y0],
    }
  );
  if (!fitted) return;
  const { h, w } = fitted;
  // Its top left corner stays put on the page, the card turned or not.
  const corner = turned(
    model.rotate,
    was.center as Vec,
    -was.w / 2,
    -was.h / 2
  );
  const [cx, cy] = turned(model.rotate, corner, w / 2, h / 2);
  model.surface.store.withoutTransact(() => {
    model.ppu = fitted.ppu.x;
    model.x0 = fitted.x0;
    model.y0 = fitted.y0;
    model.xywh = new Bound(cx - w / 2, cy - h / 2, w, h).serialize();
  });
}

/** Custom size: the card keeps its size, and the plane in it is framed round its
 * marks, as a graph figure's window is (`fitWindow`): the card's size is board
 * layout and never decides what of the plane shows (Epo 2026-11-18, "custom
 * size should mean the card on the canvas is on custom size, it never dictates
 * how the plane is drawn"). Nothing to frame keeps the view as it is. */
export function fitView(model: PlaneElementModel) {
  const { h, w } = Bound.deserialize(model.xywh);
  const box = fitWindow(
    model.elementList,
    { height: h, width: w },
    [model.x0, model.y0, model.x0 + w / model.ppu, model.y0 - h / model.ppu],
    { max: FIT_SIDE_MAX, minH: CARD_HEIGHT_MIN, minW: CARD_WIDTH_MIN }
  );
  if (!box) return;
  const [left, top, right] = box;
  const ppu = w / (right - left);
  if (!(ppu >= PLANE_ZOOM.min && ppu <= PLANE_ZOOM.max)) return;
  model.surface.store.withoutTransact(() => {
    model.ppu = ppu;
    model.x0 = left;
    model.y0 = top;
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
    fit: false,
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
