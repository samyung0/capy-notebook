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
} from '@blocksuite/affine/std/gfx';
import { axisNumber } from '@/features/questions/graph';
import { tickStep } from '@/features/questions/graphTicks';
import { LATEX_MAX, type Mark, PAPER, type Paper, pointsOf } from './boardData';
import { type Drawn, drawing, laidOut, replay } from './boardFormulaDraw';
import { curvePieces, minorStep, ticks, type Vec } from './boardGeometry';

/** The plane's top left corner in its own units, and board pixels per unit. A polar
 * plane draws rings and spokes round its origin instead of squares (Epo 2026-11-08). */
export type PlaneView = {
  polar?: boolean;
  ppu: number;
  x0: number;
  y0: number;
};

/** A polar plane's spokes: a light one every 15°, a darker one every 30°. */
export const POLAR_SPOKE = 15;
export type Frame = { h: number; w: number; x: number; y: number };

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
  marks: Mark[],
  paper: Paper,
  /** Marks whose points show (the editor's, under the pointer). */
  shown: ReadonlySet<string> = NONE,
  /** Draws again once a formula on it is laid out. */
  refresh: () => void = () => undefined
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
  ctx.fillStyle = paper.paper;
  ctx.fill();
  ctx.clip();

  const step = tickStep(view.ppu);
  const minor = minorStep(step);
  if (view.polar) {
    drawPolarGrid(ctx, frame, view, X, Y, step, minor, paper);
    drawMarks(ctx, X, Y, marks, paper, shown, refresh);
    ctx.restore();
    ctx.strokeStyle = paper.edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
    return;
  }
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
  grid(minor, paper.minor);
  grid(step, paper.major);

  // Numbers sit by their axis and leave with it (Epo 2026-11-06).
  const axisX = X(0);
  const axisY = Y(0);
  ctx.strokeStyle = paper.axis;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(axisX, frame.y);
  ctx.lineTo(axisX, frame.y + frame.h);
  ctx.moveTo(frame.x, axisY);
  ctx.lineTo(frame.x + frame.w, axisY);
  ctx.stroke();
  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = paper.number;
  ctx.textBaseline = 'middle';
  const label = (text: string, x: number, y: number, align: CanvasTextAlign) =>
    haloText(ctx, text, x, y, align, paper);
  for (const x of ticks(left, right, step))
    label(axisNumber(x, step), X(x), axisY + 14, 'center');
  for (const y of ticks(bottom, top, step))
    label(axisNumber(y, step), axisX - 7, Y(y), 'right');

  drawMarks(ctx, X, Y, marks, paper, shown, refresh);
  ctx.restore();
  ctx.strokeStyle = paper.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
}

/** Text with a halo of the paper, so grid lines don't cross it. */
function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign,
  paper: Paper
) {
  if (!text) return;
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = paper.paper;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** Rings at the grid's steps round the origin, numbered along 0°, and spokes with their
 * angles where they leave the card. */
function drawPolarGrid(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  view: PlaneView,
  X: (x: number) => number,
  Y: (y: number) => number,
  step: number,
  minor: number,
  paper: Paper
) {
  const ox = X(0);
  const oy = Y(0);
  // Out to the card's farthest corner, in plane units.
  const reach =
    Math.max(
      Math.hypot(frame.x - ox, frame.y - oy),
      Math.hypot(frame.x + frame.w - ox, frame.y - oy),
      Math.hypot(frame.x - ox, frame.y + frame.h - oy),
      Math.hypot(frame.x + frame.w - ox, frame.y + frame.h - oy)
    ) / view.ppu;
  const rings = (every: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = every; r <= reach; r += every) {
      ctx.moveTo(ox + r * view.ppu, oy);
      ctx.arc(ox, oy, r * view.ppu, 0, Math.PI * 2);
    }
    ctx.stroke();
  };
  rings(minor, paper.minor);
  const far = reach * view.ppu;
  for (let a = 0; a < 360; a += POLAR_SPOKE) {
    const t = (a * Math.PI) / 180;
    ctx.strokeStyle =
      a % 90 === 0 ? paper.axis : a % 30 === 0 ? paper.major : paper.minor;
    ctx.lineWidth = a % 90 === 0 ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + far * Math.cos(t), oy - far * Math.sin(t));
    ctx.stroke();
  }
  rings(step, paper.major);
  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = paper.number;
  ctx.textBaseline = 'middle';
  for (let r = step; r <= reach; r += step)
    haloText(
      ctx,
      axisNumber(r, step),
      ox + r * view.ppu,
      oy + 14,
      'center',
      paper
    );
  // Each 30° spoke's angle, just inside where it leaves the card.
  const inset = 16;
  const [left, right] = [frame.x + inset, frame.x + frame.w - inset];
  const [top, bottom] = [frame.y + inset, frame.y + frame.h - inset];
  for (let a = 30; a < 360; a += 30) {
    if (a % 90 === 0 && a !== 90 && a !== 270) continue;
    const t = (a * Math.PI) / 180;
    const [dx, dy] = [Math.cos(t), -Math.sin(t)];
    const hits = [
      dx > 0
        ? (right - ox) / dx
        : dx < 0
          ? (left - ox) / dx
          : Number.POSITIVE_INFINITY,
      dy > 0
        ? (bottom - oy) / dy
        : dy < 0
          ? (top - oy) / dy
          : Number.POSITIVE_INFINITY,
    ];
    const k = Math.min(...hits);
    if (!(k > 24)) continue;
    haloText(ctx, `${a}°`, ox + dx * k, oy + dy * k, 'center', paper);
  }
}

/** Dots, lines and curves; marks keep their thickness whatever the plane's zoom. */
/** A line, curve or ellipse as a canvas path, smooth at any zoom; the caller strokes
 * it. */
export function traceMark(
  ctx: CanvasRenderingContext2D,
  mark: Extract<Mark, { points: Vec[] }>,
  X: (x: number) => number,
  Y: (y: number) => number
) {
  ctx.beginPath();
  if (mark.kind === 'ellipse') {
    const [[right, cy], [cx, top]] = mark.points;
    ctx.ellipse(
      X(cx),
      Y(cy),
      Math.abs(X(right) - X(cx)),
      Math.abs(Y(top) - Y(cy)),
      0,
      0,
      Math.PI * 2
    );
    return;
  }
  const [first] = mark.points;
  ctx.moveTo(X(first[0]), Y(first[1]));
  if (mark.kind === 'curve')
    for (const [, c1, c2, to] of curvePieces(mark.points))
      ctx.bezierCurveTo(
        X(c1[0]),
        Y(c1[1]),
        X(c2[0]),
        Y(c2[1]),
        X(to[0]),
        Y(to[1])
      );
  else for (const [x, y] of mark.points.slice(1)) ctx.lineTo(X(x), Y(y));
}

/** A vector's arrowhead, filled with the context's fill, at its second point. */
export function arrowHead(
  ctx: CanvasRenderingContext2D,
  mark: Extract<Mark, { points: Vec[] }>,
  X: (x: number) => number,
  Y: (y: number) => number
) {
  const [from, to] = mark.points.slice(-2);
  if (!(from && to)) return;
  const [x, y] = [X(to[0]), Y(to[1])];
  const turn = Math.atan2(y - Y(from[1]), x - X(from[0]));
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (const side of [-1, 1])
    ctx.lineTo(
      x - ARROW_LENGTH * Math.cos(turn + side * ARROW_SPREAD),
      y - ARROW_LENGTH * Math.sin(turn + side * ARROW_SPREAD)
    );
  ctx.closePath();
  ctx.fill();
}

/** The marks; a line's, curve's or ellipse's points only where `shown` names it (Epo
 * 2026-11-08: the editor shows them under the pointer), a single point always. */
function drawMarks(
  ctx: CanvasRenderingContext2D,
  X: (x: number) => number,
  Y: (y: number) => number,
  marks: Mark[],
  paper: Paper,
  shown: ReadonlySet<string>,
  refresh: () => void
) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const dot = ([x, y]: Vec) => {
    ctx.fillStyle = paper.ink;
    ctx.beginPath();
    ctx.arc(X(x), Y(y), DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const mark of marks) {
    if (mark.kind === 'dot') dot(mark.at);
    else if (mark.kind === 'label') {
      ctx.font = '15px Arial, sans-serif';
      ctx.fillStyle = paper.text;
      ctx.textBaseline = 'middle';
      haloText(ctx, mark.text, X(mark.at[0]), Y(mark.at[1]), 'center', paper);
    } else if (mark.kind === 'formula') {
      const drawn = formulaAt(mark.latex, refresh);
      if (!drawn) continue;
      const box = formulaBox(drawn, X(mark.at[0]), Y(mark.at[1]));
      ctx.save();
      // KaTeX's ink is black; dark paper turns it light, its colours about kept.
      if (paper.dark) ctx.filter = 'invert(1) hue-rotate(180deg)';
      ctx.translate(box.x, box.y);
      ctx.scale(FORMULA_SCALE, FORMULA_SCALE);
      replay(ctx, drawn);
      ctx.restore();
    } else {
      // Set per mark: a label's halo before it leaves the paper's colour behind.
      ctx.strokeStyle = paper.ink;
      ctx.lineWidth = 2;
      traceMark(ctx, mark, X, Y);
      ctx.stroke();
      if (mark.kind === 'vector') {
        ctx.fillStyle = paper.ink;
        arrowHead(ctx, mark, X, Y);
      }
      if (shown.has(mark.id)) for (const point of mark.points) dot(point);
    }
  }
}

const NONE: ReadonlySet<string> = new Set();

/** A vector's arrowhead, in screen pixels: a mark keeps its size as the plane zooms. */
const ARROW_LENGTH = 12;
const ARROW_SPREAD = Math.PI / 7;

/** A formula on a plane at 18 px, as KaTeX lays it out at 24, so it reads beside a
 * label's 15 px text; it keeps that size as the plane zooms. */
export const FORMULA_SCALE = 0.75;

/** A formula laid out, or nothing yet: it's laid out and `refresh` draws again. One
 * KaTeX can't read stays undrawn. */
export function formulaAt(latex: string, refresh: () => void) {
  if (latex.length > LATEX_MAX) return;
  const drawn = laidOut(latex);
  if (!drawn) drawing(latex).then(refresh, () => undefined);
  return drawn;
}

/** Where a formula's laid-out box sits on screen, centred on its point. */
export function formulaBox(drawn: Drawn, x: number, y: number) {
  const w = drawn.w * FORMULA_SCALE;
  const h = drawn.h * FORMULA_SCALE;
  return { h, w, x: x - w / 2, y: y - h / 2 };
}

export class PlaneElementModel extends GfxPrimitiveElementModel<{
  fit: boolean;
  index: string;
  marks: Mark[];
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

  override containsBound(bounds: Bound) {
    return Bound.deserialize(this.xywh).points.some((point) =>
      bounds.containsPoint(point as IVec)
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
      Bound.deserialize(this.xywh).points,
      point
    ) as IVec;
  }

  override includesPoint(x: number, y: number) {
    return pointInPolygon([x, y], Bound.deserialize(this.xywh).points);
  }

  /** Fit to size: the card follows its marks each time the plane is left. */
  @field()
  accessor fit = true;

  @field()
  accessor marks: Mark[] = [];

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
  ctx.setTransform(matrix);
  drawPlane(
    ctx,
    { h, w, x: 0, y: 0 },
    model,
    model.marks,
    PAPER[renderer.getColorScheme()],
    undefined,
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

/** Every point a plane's marks reach, and its origin, so the axes stay in view. */
export function markPoints(marks: Mark[]) {
  return [[0, 0] as Vec, ...marks.flatMap(pointsOf)];
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
    this.on('dblclick', () => openEditor(this.gfx, this.model));
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

/** A card on the canvas, its plane's origin towards the lower left, or in the middle
 * of a polar one. */
export function addPlane(
  gfx: GfxController,
  box: Bound,
  ppu: number,
  polar: boolean
) {
  return gfx.surface?.addElement({
    fit: true,
    marks: [],
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
      (count, element) => count + (element as PlaneElementModel).marks.length,
      0
    );
}
