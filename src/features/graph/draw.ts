/* Draws a graph in the canvas plane's look (Epo 2026-11-16, D5/D14): its grid
 * with minor lines, axes whose numbers keep to the edge they leave by, haloed numbers and ink
 * that keeps its thickness at any zoom. One renderer with no per-surface
 * switches: the editors, previews and the SVG export all draw through here. */
import {
  curveSegments,
  equationRuns,
  functionRuns,
  markEquation,
} from './curves';
import { formulaAt, formulaBox, type ReplayContext, replay } from './formula';
import {
  type Frame,
  type Graph,
  type GraphElement,
  LABEL_SIZE,
  type Vec,
} from './model';
import { PAPER, type Paper } from './paper';
import { axisNumber, minorStep, tickStep, ticks, type View } from './view';

/** What the engine draws with: a canvas's 2D context, or the SVG recorder. */
export type DrawContext = ReplayContext &
  Pick<
    CanvasRenderingContext2D,
    | 'arc'
    | 'bezierCurveTo'
    | 'closePath'
    | 'ellipse'
    | 'fill'
    | 'lineTo'
    | 'measureText'
    | 'moveTo'
    | 'scale'
    | 'setLineDash'
    | 'stroke'
    | 'strokeRect'
    | 'strokeText'
    | 'translate'
  > &
  Pick<
    CanvasRenderingContext2D,
    | 'filter'
    | 'globalAlpha'
    | 'lineCap'
    | 'lineJoin'
    | 'lineWidth'
    | 'strokeStyle'
  >;

/** A polar board's spokes: a light one every 15°, a darker one every 30°. */
export const POLAR_SPOKE = 15;
/** A point's dot, in screen pixels. */
export const DOT_RADIUS = 4.5;
/** An arrowhead, in screen pixels: a mark keeps its size as the graph zooms. */
const ARROW_LENGTH = 12;
const ARROW_SPREAD = Math.PI / 7;
/** An angle's arc and right-angle square, in screen pixels. */
const ANGLE_RADIUS = 24;
const DASH = [7, 5];
/** An implicit curve's grid, in screen pixels. */
const EQUATION_CELL = 4;
const SHADE = 0.15;
/** Label text wraps at this width in pixels (Epo 2026-10-17). */
const LABEL_WIDTH = 200;
const AFTER_SPACE = /(?<=\s)/;

/** A label's font at its size. */
const labelFont = (size = LABEL_SIZE) => `${size}px Arial, sans-serif`;

/** Greedy lines of at most LABEL_WIDTH pixels; a word wider than that (or
 * unspaced CJK) breaks between characters. */
export function wrapLabel(
  text: string,
  measure: (line: string) => number
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(AFTER_SPACE)) {
    if (measure((line + word).trimEnd()) <= LABEL_WIDTH) {
      line += word;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    for (const char of word) {
      if (line && measure(line + char) > LABEL_WIDTH) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

type Screen = {
  ctx: DrawContext;
  frame: Frame;
  paper: Paper;
  view: View;
  X: (x: number) => number;
  Y: (y: number) => number;
};

/** Draws `graph` seen through `view` into `frame`: paper, grid, axes, then
 * every element. `refresh` draws again once a formula on it is laid out. */
export function drawGraph(
  ctx: DrawContext,
  frame: Frame,
  view: View,
  graph: Graph,
  paper: Paper,
  refresh: () => void = () => undefined
) {
  const at: Screen = {
    ctx,
    frame,
    paper,
    view,
    X: (x) => frame.x + (x - view.left) * view.ppuX,
    Y: (y) => frame.y + (view.top - y) * view.ppuY,
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = paper.paper;
  ctx.fill();
  ctx.clip();
  if (graph.board.polar) drawPolarGrid(at, graph.board);
  else drawSquareGrid(at, graph.board);
  drawElements(at, graph.elements, refresh);
  ctx.restore();
  ctx.strokeStyle = paper.edge;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
}

/** Text with a halo of the paper, so grid lines don't cross it. */
function haloText(
  { ctx, paper }: Screen,
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign
) {
  if (!text) return;
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = paper.paper;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

function drawSquareGrid(at: Screen, board: Graph['board']) {
  const { ctx, frame, paper, view, X, Y } = at;
  const left = view.left;
  const right = view.left + frame.w / view.ppuX;
  const top = view.top;
  const bottom = view.top - frame.h / view.ppuY;
  const stepX = tickStep(view.ppuX);
  const stepY = tickStep(view.ppuY);
  ctx.setLineDash([]);
  if (board.grid) {
    const grid = (everyX: number, everyY: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of ticks(left, right, everyX)) {
        ctx.moveTo(X(x), frame.y);
        ctx.lineTo(X(x), frame.y + frame.h);
      }
      for (const y of ticks(bottom, top, everyY)) {
        ctx.moveTo(frame.x, Y(y));
        ctx.lineTo(frame.x + frame.w, Y(y));
      }
      ctx.stroke();
    };
    grid(minorStep(stepX), minorStep(stepY), paper.minor);
    grid(stepX, stepY, paper.major);
  }
  if (!board.axis) return;
  // Numbers sit by their axis; one gone past an edge leaves them on that edge,
  // as Desmos keeps them (Epo 2026-11-18, "do what other apps do"; GeoGebra's
  // "Stick to edge").
  const axisX = X(0);
  const axisY = Y(0);
  ctx.strokeStyle = paper.axis;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (axisX >= frame.x && axisX <= frame.x + frame.w) {
    ctx.moveTo(axisX, frame.y);
    ctx.lineTo(axisX, frame.y + frame.h);
  }
  if (axisY >= frame.y && axisY <= frame.y + frame.h) {
    ctx.moveTo(frame.x, axisY);
    ctx.lineTo(frame.x + frame.w, axisY);
  }
  ctx.stroke();
  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = paper.number;
  ctx.textBaseline = 'middle';
  const [frameRight, frameBottom] = [frame.x + frame.w, frame.y + frame.h];
  // Under the x axis, kept between the top and bottom edges.
  const numbersY = Math.min(
    Math.max(axisY + 14, frame.y + 10),
    frameBottom - 8
  );
  for (const x of ticks(left, right, stepX))
    haloText(at, axisNumber(x, stepX), X(x), numbersY, 'center');
  for (const y of ticks(bottom, top, stepY)) {
    const text = axisNumber(y, stepY);
    // Left of the y axis; past the right edge, on it; with no room left of
    // the axis (near or past the left edge), right of it on the frame.
    if (axisX > frameRight) {
      haloText(at, text, frameRight - EDGE_GAP, Y(y), 'right');
      continue;
    }
    // 12 px Arial digits are under 7 px wide: an estimate, as previews have
    // nothing to measure with and draw many.
    if (axisX - 7 - text.length * 7 < frame.x + EDGE_GAP)
      haloText(at, text, Math.max(axisX + 7, frame.x + EDGE_GAP), Y(y), 'left');
    else haloText(at, text, axisX - 7, Y(y), 'right');
  }
}

/** The room between a number pinned to an edge and that edge. */
const EDGE_GAP = 4;

/** Rings at the grid's steps round the origin, numbered along 0°, and spokes with their
 * angles where they leave the frame. */
function drawPolarGrid(at: Screen, board: Graph['board']) {
  const { ctx, frame, paper, view, X, Y } = at;
  const ox = X(0);
  const oy = Y(0);
  const ppu = view.ppuX;
  const squash = view.ppuY / view.ppuX;
  // Out to the frame's farthest corner, in plane units.
  const reach =
    Math.max(
      Math.hypot(frame.x - ox, (frame.y - oy) / squash),
      Math.hypot(frame.x + frame.w - ox, (frame.y - oy) / squash),
      Math.hypot(frame.x - ox, (frame.y + frame.h - oy) / squash),
      Math.hypot(frame.x + frame.w - ox, (frame.y + frame.h - oy) / squash)
    ) / ppu;
  const step = tickStep(ppu);
  const minor = minorStep(step);
  ctx.setLineDash([]);
  const rings = (every: number, color: string) => {
    // As the square grid's cap: a ring too fine to draw leaves them all out.
    if (!(reach / every <= 1000)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i * every <= reach; i++) {
      const r = i * every;
      ctx.moveTo(ox + r * ppu, oy);
      ctx.ellipse(ox, oy, r * ppu, r * view.ppuY, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
  };
  const far = reach * ppu;
  if (board.grid) rings(minor, paper.minor);
  for (let a = 0; a < 360; a += POLAR_SPOKE) {
    const axis = a % 90 === 0;
    if (axis ? !board.axis : !board.grid) continue;
    const t = (a * Math.PI) / 180;
    ctx.strokeStyle = axis
      ? paper.axis
      : a % 30 === 0
        ? paper.major
        : paper.minor;
    ctx.lineWidth = axis ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + far * Math.cos(t), oy - far * squash * Math.sin(t));
    ctx.stroke();
  }
  if (board.grid) rings(step, paper.major);
  if (!board.axis) return;
  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = paper.number;
  ctx.textBaseline = 'middle';
  if (reach / step <= 1000)
    for (let i = 1; i * step <= reach; i++)
      haloText(
        at,
        axisNumber(i * step, step),
        ox + i * step * ppu,
        oy + 14,
        'center'
      );
  // Each 30° spoke's angle, just inside where it leaves the frame.
  const inset = 16;
  const [left, right] = [frame.x + inset, frame.x + frame.w - inset];
  const [top, bottom] = [frame.y + inset, frame.y + frame.h - inset];
  for (let a = 30; a < 360; a += 30) {
    if (a % 90 === 0 && a !== 90 && a !== 270) continue;
    const t = (a * Math.PI) / 180;
    const [dx, dy] = [Math.cos(t), -Math.sin(t) * squash];
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
    haloText(at, `${a}°`, ox + dx * k, oy + dy * k, 'center');
  }
}

const unit = ([x, y]: Vec): Vec => {
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
};

/** The part of the infinite line through a and b inside the frame (a pixel
 * out), or null when it misses it. */
function lineInFrame(a: Vec, b: Vec, frame: Frame): [Vec, Vec] | null {
  const d: Vec = [b[0] - a[0], b[1] - a[1]];
  if (!(d[0] || d[1])) return null;
  let low = Number.NEGATIVE_INFINITY;
  let high = Number.POSITIVE_INFINITY;
  const edges: [number, number, number][] = [
    [d[0], a[0], frame.x - 1],
    [-d[0], -a[0], -(frame.x + frame.w + 1)],
    [d[1], a[1], frame.y - 1],
    [-d[1], -a[1], -(frame.y + frame.h + 1)],
  ];
  // Each edge keeps a ≥ edge along the line: d·t + a ≥ edge.
  for (const [dk, ak, edge] of edges) {
    if (dk === 0) {
      if (ak < edge) return null;
      continue;
    }
    const t = (edge - ak) / dk;
    if (dk > 0) low = Math.max(low, t);
    else high = Math.min(high, t);
  }
  if (!(low <= high)) return null;
  return [
    [a[0] + d[0] * low, a[1] + d[1] * low],
    [a[0] + d[0] * high, a[1] + d[1] * high],
  ];
}

/** A stroke through screen points; with `arrow` it stops halfway into the
 * arrowhead at its end, so its round end doesn't show past the point (Epo
 * 2026-11-13), and the head is filled there. */
function strokeLine(ctx: DrawContext, points: Vec[], arrow: boolean) {
  const rest = points.slice(1);
  const tip = rest.at(-1);
  const from = rest.at(-2) ?? points[0];
  if (arrow && tip) {
    const length = Math.hypot(tip[0] - from[0], tip[1] - from[1]);
    const back = Math.min(length, (ARROW_LENGTH * Math.cos(ARROW_SPREAD)) / 2);
    if (length)
      rest[rest.length - 1] = [
        tip[0] - ((tip[0] - from[0]) / length) * back,
        tip[1] - ((tip[1] - from[1]) / length) * back,
      ];
  }
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of rest) ctx.lineTo(x, y);
  ctx.stroke();
  if (!(arrow && tip)) return;
  const turn = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  for (const side of [-1, 1])
    ctx.lineTo(
      tip[0] - ARROW_LENGTH * Math.cos(turn + side * ARROW_SPREAD),
      tip[1] - ARROW_LENGTH * Math.sin(turn + side * ARROW_SPREAD)
    );
  ctx.closePath();
  ctx.fill();
}

/** Fills the current path lightly with the ink, then strokes it. */
function shadeAndStroke(ctx: DrawContext, shade: boolean | undefined) {
  if (shade) {
    ctx.globalAlpha = SHADE;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.stroke();
}

/** Equal sides carry the same number of short marks across their middle. */
function hatch(ctx: DrawContext, a: Vec, b: Vec, count: number) {
  const [ux, uy] = unit([b[0] - a[0], b[1] - a[1]]);
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let k = 0; k < count; k++) {
    const along = (k - (count - 1) / 2) * 5;
    const [cx, cy] = [mx + ux * along, my + uy * along];
    ctx.moveTo(cx + uy * 5, cy - ux * 5);
    ctx.lineTo(cx - uy * 5, cy + ux * 5);
  }
  ctx.stroke();
}

type Label = {
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  size?: number;
  text: string;
  x: number;
  y: number;
};

/** The elements: strokes and fills in order, then points over them, then
 * names and labels over everything so they stay readable. A hidden element
 * draws nothing; a hidden point is still where constructions find it. */
function drawElements(
  at: Screen,
  elements: GraphElement[],
  refresh: () => void
) {
  const { ctx, paper } = at;
  const points = pointsById(elements);
  const labels: Label[] = [];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = paper.ink;
  for (const element of elements) {
    if (element.hidden || element.type === 'point') continue;
    drawElement(at, element, points, labels, refresh, paper.ink, 2);
  }
  drawPoints(at, elements, labels);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = paper.text;
  for (const label of labels) {
    ctx.font = labelFont(label.size);
    ctx.textBaseline = label.baseline;
    haloText(at, label.text, label.x, label.y, label.align);
  }
}

const pointsById = (elements: GraphElement[]) =>
  new Map(
    elements.flatMap((element) =>
      element.type === 'point' ? [[element.id, element.coords] as const] : []
    )
  );

/** A label's lines, wrapped as drawn, and the box they fill centred on (x, y),
 * in screen pixels. Sets the context's font to the label's. */
export function textBox(
  ctx: Pick<DrawContext, 'font' | 'measureText'>,
  text: string,
  size: number,
  x: number,
  y: number
) {
  ctx.font = labelFont(size);
  const lines = wrapLabel(text, (line) => ctx.measureText(line).width);
  const w = Math.max(0, ...lines.map((line) => ctx.measureText(line).width));
  const h = lines.length * size * 1.2;
  return { h, lines, w, x: x - w / 2, y: y - h / 2 };
}

/** One element's stroke in `ink` at `width` pixels, over a drawn graph: an
 * editor's highlight or a mark still being drawn. Points, labels and formulas
 * are the editor's own to show. `elements` holds the points a construction
 * names. */
export function strokeElement(
  ctx: DrawContext,
  frame: Frame,
  view: View,
  element: GraphElement,
  ink: string,
  width: number,
  elements: GraphElement[] = []
) {
  if (
    element.type === 'point' ||
    element.type === 'text' ||
    element.type === 'formula'
  )
    return;
  const at: Screen = {
    ctx,
    frame,
    paper: { ...PAPER.light, ink },
    view,
    X: (x) => frame.x + (x - view.left) * view.ppuX,
    Y: (y) => frame.y + (view.top - y) * view.ppuY,
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  drawElement(
    at,
    element,
    pointsById(elements),
    [],
    () => undefined,
    ink,
    width
  );
  ctx.setLineDash([]);
}

/** One element in `ink`, its strokes `width` pixels wide; its text goes on
 * `labels`, drawn over everything after. */
function drawElement(
  at: Screen,
  element: GraphElement,
  points: Map<string, Vec>,
  labels: Label[],
  refresh: () => void,
  ink: string,
  width: number
) {
  const { ctx, frame, paper, view, X, Y } = at;
  const S = ([x, y]: Vec): Vec => [X(x), Y(y)];
  const pointAt = (id: string) => {
    const found = points.get(id);
    return found && S(found);
  };
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = width;
  ctx.setLineDash('dash' in element && element.dash ? DASH : []);
  switch (element.type) {
    case 'expression': {
      const right = view.left + frame.w / view.ppuX;
      const bottom = view.top - frame.h / view.ppuY;
      // A function sampled every two pixels across; an implicit curve on a
      // grid every few (it redraws on every pan frame).
      const runs = markEquation(element.latex)
        ? equationRuns(
            element,
            [view.left, bottom, right, view.top],
            [EQUATION_CELL / view.ppuX, EQUATION_CELL / view.ppuY]
          )
        : functionRuns(
            element,
            view.left,
            right,
            2 / view.ppuX,
            frame.h / view.ppuY
          );
      ctx.beginPath();
      for (const run of runs) {
        let drawing = false;
        for (const point of run) {
          const [x, y] = S(point);
          // Past a float's range at an extreme zoom: the run breaks.
          if (!(Number.isFinite(x) && Number.isFinite(y))) drawing = false;
          else if (drawing) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            drawing = true;
          }
        }
      }
      ctx.stroke();
      break;
    }
    case 'line': {
      const [a, b] = element.points.map(pointAt);
      const span = a && b && lineInFrame(a, b, frame);
      if (span) strokeLine(ctx, span, false);
      break;
    }
    case 'segment': {
      const [a, b] = element.points.map(pointAt);
      if (!(a && b)) break;
      strokeLine(ctx, [a, b], Boolean(element.arrow));
      if (element.ticks) hatch(ctx, a, b, element.ticks);
      break;
    }
    case 'polyline':
      if (element.coords.length > 1)
        strokeLine(ctx, element.coords.map(S), Boolean(element.arrow));
      break;
    case 'curve': {
      if (element.coords.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(...S(element.coords[0]));
      for (const [, c1, c2, to] of curveSegments(
        element.coords,
        element.handles
      ))
        ctx.bezierCurveTo(...S(c1), ...S(c2), ...S(to));
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      const [cx, cy] = S(element.center);
      ctx.beginPath();
      ctx.ellipse(
        cx,
        cy,
        Math.abs(element.radii[0] * view.ppuX),
        Math.abs(element.radii[1] * view.ppuY),
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
      break;
    }
    case 'circle': {
      const center = pointAt(element.center);
      if (!center) break;
      ctx.beginPath();
      ctx.ellipse(
        center[0],
        center[1],
        element.radius * view.ppuX,
        element.radius * view.ppuY,
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
      break;
    }
    case 'arc':
    case 'sector': {
      const center = points.get(element.center);
      const [from, to] = element.points.map((id) => points.get(id));
      if (!(center && from && to)) break;
      // Counterclockwise from the first point round to the second's direction,
      // at the first point's distance.
      const r = Math.hypot(from[0] - center[0], from[1] - center[1]);
      const start = Math.atan2(from[1] - center[1], from[0] - center[0]);
      let end = Math.atan2(to[1] - center[1], to[0] - center[0]);
      if (end <= start) end += Math.PI * 2;
      const [cx, cy] = S(center);
      ctx.beginPath();
      if (element.type === 'sector') ctx.moveTo(cx, cy);
      ctx.ellipse(cx, cy, r * view.ppuX, r * view.ppuY, 0, -start, -end, true);
      if (element.type === 'sector') {
        ctx.closePath();
        shadeAndStroke(ctx, element.shade);
      } else ctx.stroke();
      break;
    }
    case 'polygon': {
      const corners = element.points.map(pointAt);
      if (!corners.every(Boolean)) break;
      ctx.beginPath();
      for (const corner of corners as Vec[]) ctx.lineTo(...corner);
      ctx.closePath();
      shadeAndStroke(ctx, element.shade);
      break;
    }
    case 'angle': {
      const [first, vertex, second] = element.points.map((id) =>
        points.get(id)
      );
      if (!(first && vertex && second)) break;
      const v = S(vertex);
      const u1 = unit([X(first[0]) - v[0], Y(first[1]) - v[1]]);
      const u2 = unit([X(second[0]) - v[0], Y(second[1]) - v[1]]);
      // Square at 90° on the plane, whatever the axes' scales.
      const turn = Math.abs(
        Math.atan2(second[1] - vertex[1], second[0] - vertex[0]) -
          Math.atan2(first[1] - vertex[1], first[0] - vertex[0])
      );
      const square =
        Math.abs(Math.min(turn, Math.PI * 2 - turn) - Math.PI / 2) < 1e-9;
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (square) {
        const side = ANGLE_RADIUS * 0.7;
        ctx.moveTo(v[0] + u1[0] * side, v[1] + u1[1] * side);
        ctx.lineTo(
          v[0] + (u1[0] + u2[0]) * side,
          v[1] + (u1[1] + u2[1]) * side
        );
        ctx.lineTo(v[0] + u2[0] * side, v[1] + u2[1] * side);
      } else {
        // The arc under 180°, whichever way round that is on screen.
        const a1 = Math.atan2(u1[1], u1[0]);
        let sweep = Math.atan2(u2[1], u2[0]) - a1;
        if (sweep > Math.PI) sweep -= Math.PI * 2;
        if (sweep < -Math.PI) sweep += Math.PI * 2;
        ctx.moveTo(
          v[0] + Math.cos(a1) * ANGLE_RADIUS,
          v[1] + Math.sin(a1) * ANGLE_RADIUS
        );
        ctx.arc(v[0], v[1], ANGLE_RADIUS, a1, a1 + sweep, sweep < 0);
      }
      ctx.stroke();
      if (!element.label) break;
      // The value on the bisector just beyond the arc, inside the angle; narrow
      // angles push it out until the wedge fits about two characters, up to 70px.
      let [mx, my] = [u1[0] + u2[0], u1[1] + u2[1]];
      if (Math.hypot(mx, my) < 1e-6) [mx, my] = [u1[1], -u1[0]];
      [mx, my] = unit([mx, my]);
      const half =
        Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) / 2;
      const distance = Math.min(
        70,
        Math.max(ANGLE_RADIUS * 1.6, 15 / Math.tan(Math.max(half, 0.05)))
      );
      labels.push({
        align: 'center',
        baseline: 'middle',
        text: element.label,
        x: v[0] + mx * distance,
        y: v[1] + my * distance,
      });
      break;
    }
    case 'text': {
      const size = element.size ?? LABEL_SIZE;
      const [x, y] = S(element.coords);
      const { lines } = textBox(ctx, element.text, size, x, y);
      for (const [i, text] of lines.entries())
        labels.push({
          align: 'center',
          baseline: 'middle',
          size,
          text,
          x,
          y: y + (i - (lines.length - 1) / 2) * size * 1.2,
        });
      break;
    }
    case 'formula': {
      const drawn = formulaAt(element.latex, refresh);
      if (!drawn) break;
      const box = formulaBox(drawn, ...S(element.coords), element.size);
      ctx.save();
      // KaTeX's ink is black; dark paper turns it light, its colours about kept.
      if (paper.dark) ctx.filter = 'invert(1) hue-rotate(180deg)';
      ctx.translate(box.x, box.y);
      ctx.scale(box.scale, box.scale);
      replay(ctx, drawn);
      ctx.restore();
      break;
    }
  }
}

/** Dots, and each named point's name on the side facing away from the named
 * points' middle, so a vertex's name lands outside its polygon. */
function drawPoints(at: Screen, elements: GraphElement[], labels: Label[]) {
  const { ctx, paper, view, X, Y } = at;
  const shown = elements.filter(
    (element): element is Extract<GraphElement, { type: 'point' }> =>
      element.type === 'point' && !element.hidden
  );
  const named = shown.filter((point) => point.name);
  const centre = named.length
    ? named
        .reduce(
          ([x, y], point) => [x + point.coords[0], y + point.coords[1]],
          [0, 0]
        )
        .map((sum) => sum / named.length)
    : [0, 0];
  ctx.fillStyle = paper.ink;
  for (const point of shown) {
    const [x, y] = [X(point.coords[0]), Y(point.coords[1])];
    ctx.beginPath();
    ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    if (!point.name) continue;
    const dx = (point.coords[0] - centre[0]) * view.ppuX;
    const dy = (point.coords[1] - centre[1]) * view.ppuY;
    const length = Math.hypot(dx, dy);
    if (named.length < 3 || length < 1)
      labels.push({
        align: 'left',
        baseline: 'bottom',
        text: point.name,
        x: x + 6,
        y: y - 4,
      });
    else
      labels.push({
        align: dx >= 0 ? 'left' : 'right',
        baseline: dy >= 0 ? 'bottom' : 'top',
        text: point.name,
        x: x + (dx / length) * 8,
        y: y - (dy / length) * 8,
      });
  }
}
