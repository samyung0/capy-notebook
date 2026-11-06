import {
  type ElementRenderer,
  ElementRendererExtension,
  elementsCtorMap,
} from '@blocksuite/affine/blocks/surface';
import {
  Bound,
  type IVec,
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
} from '@blocksuite/affine/std/gfx';
import { axisNumber, tickStep } from '@/features/questions/graph';
import { minorStep, smoothThrough, ticks, type Vec } from './boardGeometry';

/** What's plotted on a plane, in its own units. A line or curve grows a click at a time,
 * each click one undo step. */
export type Mark =
  | { id: string; kind: 'dot'; at: Vec }
  | { id: string; kind: 'line' | 'curve'; points: Vec[] };

/** The plane's top left corner in its own units, and board pixels per unit. Without
 * axes it's a squared sheet: the grid alone. */
export type PlaneView = { axes?: boolean; ppu: number; x0: number; y0: number };
export type Frame = { h: number; w: number; x: number; y: number };

/** Most marks one plane holds. */
export const MARKS_MAX = 500;

const DOT_RADIUS = 4.5;
const CARD_WIDTH_MIN = 120;
const CARD_HEIGHT_MIN = 80;
const CARD_SIDE_MAX = 4000;
/** Fit to size: the room left around the marks, and the longest side before it zooms
 * out instead of growing. */
const FIT_PAD = 40;
const FIT_SIDE_MAX = 1600;
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

export function drawPlane(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  view: PlaneView,
  marks: Mark[]
) {
  const X = (x: number) => frame.x + (x - view.x0) * view.ppu;
  const Y = (y: number) => frame.y + (view.y0 - y) * view.ppu;
  const left = view.x0;
  const right = view.x0 + frame.w / view.ppu;
  const top = view.y0;
  const bottom = view.y0 - frame.h / view.ppu;
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.clip();

  const step = tickStep(view.ppu);
  const minor = minorStep(step);
  const grid = (every: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of ticks(left, right, every)) {
      ctx.moveTo(X(x), frame.y);
      ctx.lineTo(X(x), frame.y + frame.h);
    }
    for (const y of ticks(bottom, top, every)) {
      ctx.moveTo(frame.x, Y(y));
      ctx.lineTo(frame.x + frame.w, Y(y));
    }
    ctx.stroke();
  };
  grid(minor, '#f1f1ef');
  grid(step, '#dededb');
  if (view.axes === false) {
    ctx.restore();
    ctx.strokeStyle = '#d9d9d6';
    ctx.lineWidth = 1;
    ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
    return;
  }

  // Numbers sit by their axis and leave with it (Epo 2026-11-06).
  const axisX = X(0);
  const axisY = Y(0);
  ctx.strokeStyle = '#6f6f6c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(axisX, frame.y);
  ctx.lineTo(axisX, frame.y + frame.h);
  ctx.moveTo(frame.x, axisY);
  ctx.lineTo(frame.x + frame.w, axisY);
  ctx.stroke();
  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = '#55555b';
  ctx.textBaseline = 'middle';
  const label = (
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign
  ) => {
    if (!text) return;
    ctx.textAlign = align;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  };
  for (const x of ticks(left, right, step))
    label(axisNumber(x, step), X(x), axisY + 14, 'center');
  for (const y of ticks(bottom, top, step))
    label(axisNumber(y, step), axisX - 7, Y(y), 'right');

  // Marks keep their thickness whatever the plane's zoom.
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const dot = ([x, y]: Vec) => {
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(X(x), Y(y), DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  };
  const trace = (points: Vec[]) => {
    ctx.beginPath();
    for (const [i, [x, y]] of points.entries())
      if (i) ctx.lineTo(X(x), Y(y));
      else ctx.moveTo(X(x), Y(y));
    ctx.stroke();
  };
  for (const mark of marks) {
    if (mark.kind === 'dot') dot(mark.at);
    else {
      trace(mark.kind === 'curve' ? smoothThrough(mark.points) : mark.points);
      for (const point of mark.points) dot(point);
    }
  }
  ctx.restore();
  ctx.strokeStyle = '#d9d9d6';
  ctx.lineWidth = 1;
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
}

export class PlaneElementModel extends GfxPrimitiveElementModel<{
  axes: boolean;
  fit: boolean;
  index: string;
  marks: Mark[];
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

  override containsBound(bounds: Bound) {
    return Bound.deserialize(this.xywh).points.some((point) =>
      bounds.containsPoint(point as IVec)
    );
  }

  /** The eraser asks this, so it leaves a card alone: its marks are erased inside. */
  override getLineIntersections() {
    return null;
  }

  override getNearestPoint(point: IVec) {
    return polygonNearestPoint(
      Bound.deserialize(this.xywh).points,
      point
    ) as IVec;
  }

  override includesPoint(x: number, y: number) {
    return pointInPolygon([x, y], Bound.deserialize(this.xywh).points);
  }

  /** A squared sheet has none, and nothing to plot on. */
  @field()
  accessor axes = true;

  /** Fit to size: the card follows its marks each time the plane is left. */
  @field()
  accessor fit = true;

  @field()
  accessor marks: Mark[] = [];

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
  matrix
) => {
  const [, , w, h] = model.deserializedXYWH;
  ctx.setTransform(matrix);
  drawPlane(ctx, { h, w, x: 0, y: 0 }, model, model.marks);
};

/** The full-screen editor, set by its module so this one stays light. */
let openEditor: (gfx: GfxController, model: PlaneElementModel) => void = () =>
  undefined;
export function setPlaneEditor(open: typeof openEditor) {
  openEditor = open;
}
export const openPlane = (gfx: GfxController, model: PlaneElementModel) =>
  openEditor(gfx, model);

/** Every point a plane's marks reach, and its origin, so the axes stay in view. */
export function markPoints(marks: Mark[]) {
  return [
    [0, 0] as Vec,
    ...marks.flatMap((mark) => (mark.kind === 'dot' ? [mark.at] : mark.points)),
  ];
}

/** Sizes a card to its marks at its scale, its top left staying put. Past the longest
 * side it zooms out instead. An empty card keeps its size. Not in the undo history,
 * like the view. */
export function fitCard(model: PlaneElementModel) {
  if (!model.marks.length) return;
  const seen = markPoints(model.marks);
  const xs = seen.map(([x]) => x);
  const ys = seen.map(([, y]) => y);
  const [left, right, bottom, top] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const room = FIT_SIDE_MAX - FIT_PAD * 2;
  const ppu = Math.min(
    model.ppu,
    room / Math.max(right - left, 1e-6),
    room / Math.max(top - bottom, 1e-6)
  );
  const w = clamp(
    (right - left) * ppu + FIT_PAD * 2,
    CARD_WIDTH_MIN,
    FIT_SIDE_MAX
  );
  const h = clamp(
    (top - bottom) * ppu + FIT_PAD * 2,
    CARD_HEIGHT_MIN,
    FIT_SIDE_MAX
  );
  const [x, y] = model.deserializedXYWH;
  model.surface.store.withoutTransact(() => {
    model.ppu = ppu;
    model.x0 = (left + right) / 2 - w / 2 / ppu;
    model.y0 = (top + bottom) / 2 + h / 2 / ppu;
    model.xywh = new Bound(x, y, w, h).serialize();
  });
}

class PlaneElementView extends GfxElementModelView<PlaneElementModel> {
  static override type = 'plane';

  override onCreated() {
    super.onCreated();
    this.on('dblclick', () => {
      if (this.model.axes) openEditor(this.gfx, this.model);
    });
  }
}

/** Resizing shows more or less of the plane at the same scale: dragging the left or
 * top edge keeps what's on the plane where it is on the page. A card doesn't rotate. */
const planeInteraction = GfxViewInteractionExtension<PlaneElementView>(
  'plane',
  {
    handleResize({ model }) {
      const { x0, y0 } = model;
      return {
        onResizeEnd(context) {
          context.default(context);
          model.pop('x0');
          model.pop('y0');
        },
        onResizeMove(context) {
          const { constraint, newBound, originalBound } = context;
          const w = clamp(newBound.w, constraint.minWidth, constraint.maxWidth);
          const h = clamp(
            newBound.h,
            constraint.minHeight,
            constraint.maxHeight
          );
          // At a limit, the edge that isn't being dragged stays put.
          const x =
            newBound.x === originalBound.x
              ? newBound.x
              : newBound.x + newBound.w - w;
          const y =
            newBound.y === originalBound.y
              ? newBound.y
              : newBound.y + newBound.h - h;
          model.xywh = new Bound(x, y, w, h).serialize();
          model.x0 = x0 + (x - originalBound.x) / model.ppu;
          model.y0 = y0 - (y - originalBound.y) / model.ppu;
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
    handleRotate() {
      return {
        beforeRotate(context) {
          context.set({ rotatable: false });
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

/** A card on the canvas, its plane's origin towards the lower left unless `view`
 * places it. A question's background is locked: no tool moves, resizes or erases it. */
export function addPlane(
  gfx: GfxController,
  box: Bound,
  ppu: number,
  {
    axes = true,
    locked = false,
    view,
  }: {
    axes?: boolean;
    locked?: boolean;
    view?: { x0: number; y0: number };
  } = {}
) {
  return gfx.surface?.addElement({
    axes,
    fit: !locked,
    lockedBySelf: locked,
    marks: [],
    ppu,
    type: 'plane',
    x0: view?.x0 ?? -1,
    xywh: box.serialize(),
    y0: view?.y0 ?? (box.h * 0.7) / ppu,
  });
}

export function planeMarks(gfx: GfxController) {
  return gfx.layer.canvasElements
    .filter((element) => element.type === 'plane')
    .reduce(
      (count, element) => count + (element as PlaneElementModel).marks.length,
      0
    );
}
