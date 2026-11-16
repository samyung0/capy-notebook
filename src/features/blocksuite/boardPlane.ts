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
import { formulaAt, formulaBox, replay } from '@/features/graph/formula';
import { axisNumber, tickStep } from '@/features/graph/view';
import {
  cardPaper,
  curveSegments,
  type FunctionMark,
  functionRuns,
  LABEL_SIZE,
  type Mark,
  type Paper,
  type PathMark,
  pointsOf,
} from './boardData';
import { laidOut } from './boardFormulaDraw';
import { minorStep, ticks, type Vec } from './boardGeometry';

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
  const span: Span = { height: frame.h, left, ppu: view.ppu, right };
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
    drawMarks(ctx, X, Y, marks, paper, shown, refresh, span);
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

  drawMarks(ctx, X, Y, marks, paper, shown, refresh, span);
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
  mark: PathMark,
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
    for (const [, c1, c2, to] of curveSegments(mark))
      ctx.bezierCurveTo(
        X(c1[0]),
        Y(c1[1]),
        X(c2[0]),
        Y(c2[1]),
        X(to[0]),
        Y(to[1])
      );
  else {
    const rest = mark.points.slice(1).map(([x, y]): Vec => [X(x), Y(y)]);
    const tip = rest.at(-1);
    if (mark.kind === 'vector' && tip) {
      // The line stops halfway into the arrowhead, so its round end doesn't show
      // past the point (Epo 2026-11-13).
      const [px, py] = rest.at(-2) ?? [X(first[0]), Y(first[1])];
      const length = Math.hypot(tip[0] - px, tip[1] - py);
      const back = Math.min(
        length,
        (ARROW_LENGTH * Math.cos(ARROW_SPREAD)) / 2
      );
      if (length)
        rest[rest.length - 1] = [
          tip[0] - ((tip[0] - px) / length) * back,
          tip[1] - ((tip[1] - py) / length) * back,
        ];
    }
    for (const [x, y] of rest) ctx.lineTo(x, y);
  }
}

/** What a canvas shows of the plane: x from `left` to `right`, `height` tall, at
 * `ppu` pixels a unit. A function is drawn across it. */
export type Span = { height: number; left: number; ppu: number; right: number };

/** A function as a canvas path across what's shown, a step every 2 px; it breaks
 * where it isn't defined or leaps past the canvas's height. */
export function traceFunction(
  ctx: CanvasRenderingContext2D,
  mark: FunctionMark,
  X: (x: number) => number,
  Y: (y: number) => number,
  { height, left, ppu, right }: Span
) {
  ctx.beginPath();
  for (const run of functionRuns(mark, left, right, 2 / ppu, height / ppu)) {
    ctx.moveTo(X(run[0][0]), Y(run[0][1]));
    for (const [x, y] of run.slice(1)) ctx.lineTo(X(x), Y(y));
  }
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
  refresh: () => void,
  span: Span
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
      ctx.font = labelFont(mark.size);
      ctx.fillStyle = paper.text;
      ctx.textBaseline = 'middle';
      haloText(ctx, mark.text, X(mark.at[0]), Y(mark.at[1]), 'center', paper);
    } else if (mark.kind === 'formula') {
      const drawn = formulaAt(mark.latex, refresh);
      if (!drawn) continue;
      const box = formulaBox(drawn, X(mark.at[0]), Y(mark.at[1]), mark.size);
      ctx.save();
      // KaTeX's ink is black; dark paper turns it light, its colours about kept.
      if (paper.dark) ctx.filter = 'invert(1) hue-rotate(180deg)';
      ctx.translate(box.x, box.y);
      ctx.scale(box.scale, box.scale);
      replay(ctx, drawn);
      ctx.restore();
    } else if (mark.kind === 'function') {
      ctx.strokeStyle = paper.ink;
      ctx.lineWidth = 2;
      traceFunction(ctx, mark, X, Y, span);
      ctx.stroke();
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

export { formulaAt, formulaBox } from '@/features/graph/formula';

/** A vector's arrowhead, in screen pixels: a mark keeps its size as the plane zooms. */
const ARROW_LENGTH = 12;
const ARROW_SPREAD = Math.PI / 7;

/** A plane label's font at its size. */
export const labelFont = (size = LABEL_SIZE) => `${size}px Arial, sans-serif`;

/** Where a label's text sits on screen, centred on (x, y): its width by a line. */
export function labelBox(
  ctx: CanvasRenderingContext2D,
  { size = LABEL_SIZE, text }: { size?: number; text: string },
  x: number,
  y: number
) {
  ctx.save();
  ctx.font = labelFont(size);
  const w = ctx.measureText(text).width;
  ctx.restore();
  const h = size * 1.2;
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
    model.marks,
    cardPaper(renderer.getColorScheme()),
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

/** Every point a plane's marks reach (a curve's handles too), and its origin, so the
 * axes stay in view. A function reaches none: it runs across whatever is shown. */
export function markPoints(marks: Mark[]) {
  return [
    [0, 0] as Vec,
    ...marks.flatMap((mark) => [
      ...pointsOf(mark),
      ...('handles' in mark && mark.handles ? mark.handles.flat() : []),
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
function textReach(marks: Mark[]) {
  measurer ??= document.createElement('canvas').getContext('2d');
  return marks.flatMap((mark) => {
    if (mark.kind === 'label' && measurer) {
      const { h, w } = labelBox(measurer, mark, 0, 0);
      return [{ at: mark.at, x: w / 2, y: h / 2 }];
    }
    const drawn = mark.kind === 'formula' && laidOut(mark.latex);
    if (!drawn || mark.kind !== 'formula') return [];
    const { h, w } = formulaBox(drawn, 0, 0, mark.size);
    return [{ at: mark.at, x: w / 2, y: h / 2 }];
  });
}

/** Sizes a card to its marks at its scale, its top left staying put. Past the longest
 * side it zooms out instead. An empty card keeps its size. Not in the undo history,
 * like the view. */
export function fitCard(model: PlaneElementModel) {
  const seen = markPoints(model.marks);
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
  const texts = textReach(model.marks);
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
