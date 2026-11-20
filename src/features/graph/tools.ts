/* The drawing tools every graph editor has (Epo 2026-11-16, "the question graph
 * editor and the plane editor gain each other's tools"): the canvas plane's
 * Select, Point, Line, Vector, Curve, Ellipse, Label, Formula and Erase, with
 * their hit-testing, handles, selection and what they draw over the graph. The
 * canvas plane's editor and the question graph editor each host them: the host
 * draws the graph, holds the elements and writes each finished change. */
import * as limits from '@/api/limits.generated';
import { m } from '@/i18n';
import { sameJson } from '@/lib/sameJson';
import { DOT_RADIUS, POLAR_SPOKE, strokeElement, textBox } from './draw';
import {
  type Bend,
  bent,
  bezier,
  circleAt,
  curveSegments,
  distanceTo,
  handlesOf,
  isLoop,
  moved,
  movedGroup,
  namedPoints,
  pairOf,
  pointsById,
  pointsOf,
  pulledHandle,
  samePoint,
  snapTo,
  textBoxOf,
  toggledCorner,
  touches,
  whole,
  withDependents,
} from './marks';
import { FORMULA_SIZE, type GraphElement, LABEL_SIZE, type Vec } from './model';
import {
  CORNER_CURSOR,
  draggedSize,
  drawChip,
  drawTextFrame,
  frameCornerAt,
} from './overlay';
import {
  axisNumber,
  minorStep,
  tickStep,
  toPlane,
  toScreen,
  type View,
} from './view';

export type Tool =
  | 'select'
  | 'point'
  | 'line'
  | 'vector'
  | 'curve'
  | 'ellipse'
  | 'label'
  | 'formula'
  | 'erase';

/** With their keys, shown in their tooltips (Epo 2026-11-08). */
export const TOOLS: {
  icon: string;
  id: Tool;
  key: string;
  label: () => string;
}[] = [
  { icon: 'select', id: 'select', key: 'V', label: m.drawing_board_select },
  { icon: 'point', id: 'point', key: 'P', label: m.drawing_board_point },
  {
    icon: 'line',
    id: 'line',
    key: 'L',
    label: m.drawing_board_line_through_points,
  },
  { icon: 'vector', id: 'vector', key: 'A', label: m.drawing_board_vector },
  { icon: 'curve', id: 'curve', key: 'C', label: m.drawing_board_curve },
  { icon: 'ellipse', id: 'ellipse', key: 'O', label: m.drawing_board_ellipse },
  { icon: 'label', id: 'label', key: 'T', label: m.drawing_board_plane_label },
  {
    icon: 'formula',
    id: 'formula',
    key: 'F',
    label: m.drawing_board_plane_formula,
  },
  { icon: 'erase', id: 'erase', key: 'E', label: m.drawing_board_erase_mark },
];

/** The tools a board offers: upright ellipses belong to x and y, not to rings
 * and spokes. */
export const toolsFor = (polar: boolean) =>
  TOOLS.filter(({ id }) => !(polar && id === 'ellipse'));

/** An element's icon (`TOOL_ICONS`) in a row: the tool that makes it, or its
 * construction. */
export const kindOf = (element: GraphElement) =>
  element.type === 'polyline'
    ? element.arrow
      ? 'vector'
      : 'line'
    : element.type === 'expression'
      ? 'function'
      : element.type === 'text'
        ? 'label'
        : element.type === 'line'
          ? 'through'
          : element.type;

/** The name the Point tool gives a point (Epo 2026-11-17), so a row such as
 * `segment(A, B)` can use it: the first of A … Z, then A_1 … Z_1, A_2 …, that
 * no point in the graph has. */
export function freePointName(elements: readonly GraphElement[]) {
  const taken = new Set(
    elements.map((element) =>
      element.type === 'point' ? element.name : undefined
    )
  );
  for (let round = 0; ; round++)
    for (let letter = 0; letter < 26; letter++) {
      const name = `${String.fromCharCode(65 + letter)}${round ? `_${round}` : ''}`;
      if (!taken.has(name)) return name;
    }
}

/** The maths symbols under a label being typed. */
export const SYMBOLS = [
  '²',
  '³',
  '√',
  'π',
  'θ',
  '±',
  '≤',
  '≥',
  '≠',
  '∞',
  '→',
  '°',
];
/** Superscripts read better with something under them on the button. */
export const symbolLabel = (symbol: string) =>
  '²³'.includes(symbol) ? `x${symbol}` : symbol;

/** How wide the eraser is on the board and in an open card: BlockSuite's trail, and the
 * ring the pointer shows (Epo 2026-11-09). */
export const ERASER_SIZE = 16;

/** The pixels along a drag from one point to the next, a few apart, so a fast swipe
 * misses nothing between its pointer events. */
export function alongDrag(from: Vec, to: Vec): Vec[] {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / (ERASER_SIZE / 2))
  );
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  });
}

/** How near a line, curve or ellipse a press with Select picks it. */
const PIXELS_TO_SELECT = 12;
const PIXELS_TO_LABEL = 24;
/** How near a point's dot a press picks it up, and how far it goes before it's a drag
 * rather than a tap. */
const PIXELS_TO_GRAB = 11;
export const PIXELS_TO_DRAG = 4;
const BLUE = '#1e96eb';
const HALO = 'rgba(30, 150, 235, 0.18)';
/** A picked-up point's ring, filled solid over the see-through paper. */
const RING_FILL = { dark: '#252525', light: '#fff' };
const TEXT_SIZES: [number, number] = [
  limits.QUESTION_GRAPH_TEXT_SIZE_MIN,
  limits.QUESTION_GRAPH_TEXT_SIZE_MAX,
];

type Curve = Extract<GraphElement, { type: 'curve' }>;
export type Formula = Extract<GraphElement, { type: 'formula' }>;
type Label = Extract<GraphElement, { type: 'text' }>;

/** BlockSuite's eraser trail, which the host brings. */
export type Trail = {
  add(at: Vec): void;
  draw(ctx: CanvasRenderingContext2D): void;
  end(): void;
  start(at: Vec): void;
};

/** A label being typed on the graph, at its point; `id` when it's an old one. */
export type LabelTyping = { at: Vec; id?: string; size?: number; text: string };

export type ToolHost = {
  canvas: HTMLCanvasElement;
  /** What the overlay draws with, and measures text with. */
  ctx: CanvasRenderingContext2D;
  /** The elements as drawn now; the same array until they change. */
  elements(): GraphElement[];
  /** One finished change: every element the graph holds after it. */
  write(next: GraphElement[]): void;
  /** The camera, in the frame's pixels. */
  view(): View;
  /** The frame's size in pixels; it starts at the canvas's top left. */
  size(): { h: number; w: number };
  /** A pointer event's place in the frame's pixels. */
  local(event: MouseEvent): Vec;
  polar(): boolean;
  /** Whether the graph holds all it can; `refused` hears a new one turned away. */
  full(): boolean;
  refused(): void;
  /** Draws again on the next frame. */
  redraw(): void;
  /** The tool, the selection, the open mark or the label being typed changed. */
  changed(): void;
  /** Opens a formula for typing at `at`: `near`'s, or a new one; `done` gets its
   * LaTeX, empty to take it away. */
  formula(near: Formula | null, at: Vec, done: (latex: string) => void): void;
  /** The label field's text while one is typed. */
  labelText(): string | null;
  dark(): boolean;
  /** The selection frame's colour. */
  accent(): string;
  trail: Trail;
};

export type GraphTools = ReturnType<typeof graphTools>;

/** The tools over one graph canvas. `attach` listens on the canvas; the host's
 * gestures (wheel, pinch, middle button) take the rest. */
export function graphTools(host: ToolHost) {
  const { canvas, ctx } = host;
  let tool: Tool = 'select';
  /** The line or curve still taking clicks. Undo simply shortens it. */
  let openId: string | null = null;
  let typing: LabelTyping | null = null;
  /** Where the pointer is, in pixels, while it means something. */
  let pointer: Vec | null = null;
  /** Under the mouse: a point to pick up (with any tool but Erase), or with Select a
   * whole mark (`index` null). */
  let hover: { id: string; index: number | null } | null = null;
  /** What Select clicked, boxed or dragged, as the board's Select does: Shift adds or
   * takes away, Delete removes them all (Epo 2026-11-09). */
  let selected = new Set<string>();
  /** The selection box being dragged out on empty paper, in pixels. */
  let boxing: { adding: boolean; from: Vec; to: Vec } | null = null;
  /** What the eraser has passed over while pressed; gone in one step when it lifts. */
  let erasing: Set<string> | null = null;
  /** The line, curve or ellipse under the mouse, whose points show (Epo 2026-11-08). */
  let near: string | null = null;
  /** A new circle being sized: pressed at its middle, its radius from the drag. */
  let sizing: { centre: Vec; r: number | null; start: Vec } | null = null;
  /** The press on a mark: a tap does the tool's job, a drag moves it. Until it lifts
   * the moved copies (`preview`, the mark or every selected one with it) are only
   * drawn, so the drag is one write. */
  let grab: {
    id: string;
    index: number | null;
    preview: GraphElement[] | null;
    start: Vec;
    /** A picked point's handle being pulled: in (0) or out (1). */
    handle?: 0 | 1;
    /** The selected curve's stroke being pulled. */
    bend?: Bend;
    /** The picked label's or formula's frame corner being pulled, clockwise from
     * the top left. */
    corner?: number;
  } | null = null;
  /** The curve point whose handles show, picked with Select (Epo 2026-11-13, K1). */
  let editing: { id: string; index: number } | null = null;
  /** Where a press would bend the selected curve, under the mouse, in pixels. */
  let bendHover: Vec | null = null;
  /** The row under the pointer in the host's list, its element lit. */
  let hot: string | null = null;

  const elements = () => host.elements();
  const find = (id: string | undefined) =>
    elements().find((element) => element.id === id);
  let pointsFor: GraphElement[] | null = null;
  let pointMap = new Map<string, Vec>();
  /** Where constructions find their points, read once per change. */
  const points = () => {
    const now = elements();
    if (pointsFor !== now) {
      pointsFor = now;
      pointMap = pointsById(now);
    }
    return pointMap;
  };
  const screen = (at: Vec) => toScreen(host.view(), at);
  const plane = (px: Vec) => toPlane(host.view(), px);
  const minors = (): Vec => {
    const view = host.view();
    return [minorStep(tickStep(view.ppuX)), minorStep(tickStep(view.ppuY))];
  };
  /** To grid points; on a polar plane, to where a ring crosses a spoke. */
  const snapPlane = ([x, y]: Vec): Vec => {
    const [stepX, stepY] = minors();
    if (!host.polar()) return [snapTo(x, stepX), snapTo(y, stepY)];
    const r = snapTo(Math.hypot(x, y), stepX);
    const spoke = (POLAR_SPOKE * Math.PI) / 180;
    const t = snapTo(Math.atan2(y, x), spoke);
    return [r * Math.cos(t), r * Math.sin(t)];
  };
  const snapped = (px: Vec) => snapPlane(plane(px));
  /** Off the grid, as a label or formula is placed: to a tenth of its small step,
   * so no float dust is stored or shown in a row. */
  const loose = (px: Vec): Vec => {
    const [stepX, stepY] = minors();
    const [x, y] = plane(px);
    return [snapTo(x, stepX / 10), snapTo(y, stepY / 10)];
  };
  const numberText = ([x, y]: Vec) => {
    const [stepX, stepY] = minors();
    return `(${axisNumber(x, stepX) || 0}, ${axisNumber(y, stepY) || 0})`;
  };

  /** The point whose dot is under a pixel. */
  const pointAt = (px: Vec) => {
    let best: { id: string; index: number } | null = null;
    let reach = PIXELS_TO_GRAB;
    for (const element of elements()) {
      if (
        element.hidden ||
        element.type === 'text' ||
        element.type === 'formula'
      )
        continue;
      for (const [index, point] of pointsOf(element).entries()) {
        const [x, y] = screen(point);
        const distance = Math.hypot(x - px[0], y - px[1]);
        if (distance <= reach) {
          reach = distance;
          best = { id: element.id, index };
        }
      }
    }
    return best;
  };
  const boxOf = (element: GraphElement) =>
    textBoxOf(element, host.view(), ctx, LABEL_SIZE);
  /** Whether a pixel is on a formula: its laid-out box, or near its point until then. */
  const onFormula = (mark: Formula, px: Vec) => {
    const box = boxOf(mark);
    if (!box) {
      const [x, y] = screen(mark.coords);
      return Math.hypot(px[0] - x, px[1] - y) <= PIXELS_TO_LABEL;
    }
    return (
      px[0] >= box.x - 4 &&
      px[0] <= box.x + box.w + 4 &&
      px[1] >= box.y - 4 &&
      px[1] <= box.y + box.h + 4
    );
  };
  /** Whether a pixel is on a label's text, or near its point. */
  const onLabel = (mark: Label, px: Vec) => {
    const [x, y] = screen(mark.coords);
    const box = boxOf(mark);
    return (
      Math.hypot(px[0] - x, px[1] - y) <= PIXELS_TO_LABEL ||
      (box !== null &&
        px[0] >= box.x - 4 &&
        px[0] <= box.x + box.w + 4 &&
        px[1] >= box.y - 4 &&
        px[1] <= box.y + box.h + 4)
    );
  };
  /** The line, curve, construction, label or formula under a pixel. */
  const markAt = (px: Vec) =>
    elements().find((element) => {
      if (element.hidden || element.type === 'point') return false;
      if (element.type === 'formula') return onFormula(element, px);
      if (element.type === 'text') return onLabel(element, px);
      return (
        distanceTo(element, px, host.view(), points(), PIXELS_TO_SELECT) <=
        PIXELS_TO_SELECT
      );
    });
  const pickable = (px: Vec) => {
    if (tool === 'erase') return null;
    const point = pointAt(px);
    // With Select a single point takes its whole mark, so several selected dots move
    // together. A line's or curve's point stays its own, selected or not (Epo
    // 2026-11-13); its stroke drags the whole mark.
    if (point && tool === 'select' && find(point.id)?.type === 'point')
      return { id: point.id, index: null };
    if (point) return point;
    const mark = tool === 'select' ? markAt(px) : undefined;
    return mark ? { id: mark.id, index: null } : null;
  };
  const editingCurve = () => {
    const mark = editing && find(editing.id);
    return mark?.type === 'curve' &&
      editing &&
      editing.index < mark.coords.length
      ? mark
      : null;
  };
  /** The picked point's handle under a pixel. */
  const knobAt = (px: Vec) => {
    const mark = editingCurve();
    if (!mark || !editing || tool !== 'select') return null;
    const point = mark.coords[editing.index];
    const pair = pairOf(handlesOf(mark), editing.index, isLoop(mark.coords));
    for (const side of [0, 1] as const) {
      if (samePoint(pair[side], point)) continue;
      const [x, y] = screen(pair[side]);
      if (Math.hypot(x - px[0], y - px[1]) <= PIXELS_TO_GRAB)
        return { id: mark.id, index: editing.index, side };
    }
    return null;
  };
  /** Where a press on the one selected curve's stroke, away from its points, bends it
   * (Epo 2026-11-13, K2); with the point on the stroke, in pixels. */
  const bendAt = (px: Vec) => {
    if (tool !== 'select' || selected.size !== 1) return null;
    const [id] = selected;
    const mark = find(id);
    // Any mark's point under the press is grabbed rather than the stroke bent.
    if (mark?.type !== 'curve' || pointAt(px)) return null;
    let best: { at: Vec; d: number; piece: number; t: number } | null = null;
    for (const [piece, segment] of curveSegments(mark).entries())
      for (let step = 1; step < 48; step++) {
        const t = step / 48;
        const at = screen(bezier(segment, t));
        const d = Math.hypot(at[0] - px[0], at[1] - px[1]);
        if (d <= PIXELS_TO_SELECT && (!best || d < best.d))
          best = { at, d, piece, t };
      }
    if (!best) return null;
    const bend: Bend = {
      from: plane(px),
      handles: handlesOf(mark),
      piece: best.piece,
      t: best.t,
    };
    return { at: best.at, bend, id };
  };
  /** The one label or formula Select has picked, which wears the frame. */
  const framed = (list: GraphElement[] = elements()) => {
    if (tool !== 'select' || selected.size !== 1) return null;
    const [id] = selected;
    const mark = list.find((each) => each.id === id);
    return (mark?.type === 'text' && typing?.id !== id) ||
      mark?.type === 'formula'
      ? mark
      : null;
  };
  /** The framed text's corner under a pixel. */
  const cornerAt = (px: Vec) => {
    const mark = framed();
    const box = mark && boxOf(mark);
    const corner = box ? frameCornerAt(box, px) : null;
    return mark && corner !== null ? { corner, id: mark.id } : null;
  };

  const write = (next: GraphElement[]) => host.write(next);
  const add = (mark: GraphElement) => {
    if (host.full()) {
      host.refused();
      return false;
    }
    write([...elements(), mark]);
    return true;
  };
  const replace = (mark: GraphElement) =>
    write(elements().map((old) => (old.id === mark.id ? mark : old)));
  /** Takes these away, and what is built on them. */
  const remove = (ids: ReadonlySet<string>) => {
    const gone = withDependents(elements(), ids);
    write(elements().filter(({ id }) => !gone.has(id)));
  };

  const newId = () => crypto.randomUUID();
  const openMark = () => (openId ? find(openId) : undefined);
  /** Ends the open mark. Like AFFiNE's shape and connector tools, the tool then goes
   * back to the plain one; Point stays on, like AFFiNE's pen, as it never opens one. */
  const finish = () => {
    const open = openMark();
    openId = null;
    if (open && !whole(open))
      write(elements().filter((mark) => mark.id !== open.id));
    tool = 'select';
    pointer = null;
    host.changed();
    host.redraw();
  };
  /** A circle round `at`; its handles stretch it into an ellipse. */
  const addCircle = (at: Vec, r: number) => {
    add(circleAt(newId(), at, r));
    finish();
  };
  /** Opens a label for typing: the one near `px`, or a new one right there. */
  const typeLabel = (px: Vec) => {
    commitLabel();
    const label = elements().find(
      (mark): mark is Label => mark.type === 'text' && onLabel(mark, px)
    );
    if (label)
      typing = {
        at: label.coords,
        id: label.id,
        size: label.size,
        text: label.text,
      };
    else if (host.full()) host.refused();
    else typing = { at: loose(px), text: '' };
    host.changed();
  };
  /** Writes the label being typed: emptied, an old one goes. One label, then back
   * to Select, as the other tools do. */
  const commitLabel = () => {
    const open = typing;
    const typed = host.labelText();
    typing = null;
    if (!open || typed === null) return;
    const text = typed.trim().slice(0, limits.QUESTION_GRAPH_LABEL_MAX);
    if (text) {
      const label: GraphElement = {
        coords: open.at,
        id: open.id ?? newId(),
        ...(open.size && { size: open.size }),
        text,
        type: 'text',
      };
      if (!open.id) add(label);
      else if (text !== open.text) replace(label);
    } else if (open.id) remove(new Set([open.id]));
    if (tool === 'label') tool = 'select';
    host.changed();
  };
  /** A press lands where it lifts, so a finger can line it up against the chip. */
  const place = (px: Vec, exact?: Vec) => {
    const at = exact ?? snapped(px);
    const open = openMark();
    if (tool === 'point')
      add({
        coords: at,
        id: newId(),
        name: freePointName(elements()),
        type: 'point',
      });
    else if (tool === 'ellipse') addCircle(at, tickStep(host.view().ppuX));
    else if (tool === 'line' || tool === 'vector' || tool === 'curve') {
      if (
        (open?.type === 'polyline' || open?.type === 'curve') &&
        kindOf(open) === tool
      ) {
        const last = open.coords.at(-1);
        if (last?.[0] === at[0] && last[1] === at[1]) {
          finish();
          return;
        }
        replace({ ...open, coords: [...open.coords, at] });
        const [first] = open.coords;
        const closes =
          open.coords.length > 2 && first[0] === at[0] && first[1] === at[1];
        // A line or vector ends at its second point, a curve once it closes on its
        // first or holds the most points a graph's curve takes.
        if (
          tool !== 'curve' ||
          closes ||
          open.coords.length + 1 >= limits.QUESTION_GRAPH_PATH_MAX
        )
          finish();
        return;
      }
      const id = newId();
      if (
        add(
          tool === 'curve'
            ? { coords: [at], id, type: 'curve' }
            : {
                coords: [at],
                id,
                type: 'polyline',
                ...(tool === 'vector' && { arrow: true }),
              }
        )
      )
        openId = id;
    } else if (tool === 'label') typeLabel(px);
    else if (tool === 'formula') {
      // A click on a formula opens it again; elsewhere a new one goes where it was
      // clicked. One formula, then back to Select.
      const near =
        elements().find(
          (mark): mark is Formula =>
            mark.type === 'formula' && onFormula(mark, px)
        ) ?? null;
      const where = near?.coords ?? loose(px);
      if (!near && host.full()) {
        host.refused();
        return;
      }
      tool = 'select';
      host.changed();
      host.formula(near, where, (latex) => {
        if (latex) {
          const formula: GraphElement = {
            coords: where,
            id: near?.id ?? newId(),
            latex,
            type: 'formula',
            ...(near?.size && { size: near.size }),
          };
          if (near) replace(formula);
          else add(formula);
        } else if (near) remove(new Set([near.id]));
      });
    }
  };

  /** Every mark within the eraser's ring round a pixel joins what it's erasing. */
  const eraseNear = (px: Vec) => {
    for (const mark of elements())
      if (
        !mark.hidden &&
        (mark.type === 'formula'
          ? onFormula(mark, px)
          : distanceTo(mark, px, host.view(), points(), ERASER_SIZE / 2) <=
            ERASER_SIZE / 2)
      )
        erasing?.add(mark.id);
  };

  /** The elements as drawn: dragged copies in their place, erased ones gone. The
   * same array as `elements()` while nothing is dragged or erased. */
  let shownFrom: GraphElement[] | null = null;
  let shownPreview: GraphElement[] | null = null;
  let shownErased = 0;
  let shownList: GraphElement[] = [];
  const shown = (): GraphElement[] => {
    const list = elements();
    const preview = grab?.preview ?? null;
    if (!(preview || erasing?.size)) return list;
    if (
      shownFrom !== list ||
      shownPreview !== preview ||
      shownErased !== (erasing?.size ?? 0)
    ) {
      shownFrom = list;
      shownPreview = preview;
      shownErased = erasing?.size ?? 0;
      const gone = erasing && withDependents(list, erasing);
      shownList = list
        .map((mark) => preview?.find(({ id }) => id === mark.id) ?? mark)
        .filter(({ id }) => !gone?.has(id));
    }
    return shownList;
  };

  /** A mark's stroke over the graph, in `ink` at `width` pixels. */
  const stroke = (
    mark: GraphElement,
    list: GraphElement[],
    ink: string,
    width: number
  ) => {
    const { h, w } = host.size();
    strokeElement(
      ctx,
      { h, w, x: 0, y: 0 },
      host.view(),
      mark,
      ink,
      width,
      list
    );
  };
  const ringFill = () => RING_FILL[host.dark() ? 'dark' : 'light'];
  const dot = ([x, y]: Vec, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  /** The mark under the pointer or being dragged, in blue with its points ringed. */
  const drawPicked = (
    mark: GraphElement,
    list: GraphElement[],
    ringed: number | null
  ) => {
    stroke(mark, list, HALO, 10);
    stroke(mark, list, BLUE, 2);
    if (mark.type === 'expression') return;
    if (mark.type === 'formula') {
      const box = boxOf(mark);
      if (!box) return;
      ctx.fillStyle = HALO;
      ctx.fillRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
      return;
    }
    if (mark.type === 'text') {
      const [x, y] = screen(mark.coords);
      const box = textBox(ctx, mark.text, mark.size ?? LABEL_SIZE, x, y);
      ctx.fillStyle = HALO;
      ctx.fillRect(box.x - 6, box.y - 3, box.w + 12, box.h + 6);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = BLUE;
      const line = (mark.size ?? LABEL_SIZE) * 1.2;
      for (const [i, text] of box.lines.entries())
        ctx.fillText(text, x, y + (i - (box.lines.length - 1) / 2) * line);
      return;
    }
    // A construction's points light with it.
    const at = list === elements() ? points() : pointsById(list);
    const dots = [
      ...pointsOf(mark),
      ...namedPoints(mark).flatMap((id) => {
        const point = at.get(id);
        return point ? [point] : [];
      }),
    ];
    for (const [i, point] of dots.entries()) {
      const xy = screen(point);
      if (i === ringed) {
        ring(xy, 7);
        ctx.fillStyle = BLUE;
        dot(xy, 3);
      } else {
        ctx.fillStyle = BLUE;
        dot(xy, DOT_RADIUS);
      }
    }
  };
  const ring = ([x, y]: Vec, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = ringFill();
    ctx.fill();
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  /** The picked curve point's handles: a line out to each, a square at its end. */
  const drawHandles = (mark: Curve, index: number) => {
    const point = mark.coords[index];
    const at = screen(point);
    for (const handle of pairOf(handlesOf(mark), index, isLoop(mark.coords))) {
      if (samePoint(handle, point)) continue;
      const [x, y] = screen(handle);
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(...at);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = ringFill();
      ctx.fillRect(x - 4.5, y - 4.5, 9, 9);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
    ring(at, 6);
  };

  /** What the tools show over the drawn graph (`shown()`), in the frame's pixels:
   * the picked and selected marks, handles, frames, the selection box, the eraser's
   * trail and where the next click lands. */
  const drawOverlay = (paperInk: string) => {
    const list = shown();
    const view = host.view();
    const { w: width } = host.size();
    const preview = grab?.preview;
    // The open mark's points, and those of the mark under the pointer or held: a
    // line's, curve's or ellipse's show only then (Epo 2026-11-08).
    ctx.fillStyle = paperInk;
    for (const mark of list) {
      if (
        !(
          mark.type === 'polyline' ||
          mark.type === 'curve' ||
          mark.type === 'ellipse'
        ) ||
        !(
          mark.id === openId ||
          mark.id === near ||
          mark.id === grab?.id ||
          selected.has(mark.id)
        )
      )
        continue;
      for (const point of pointsOf(mark)) dot(screen(point), DOT_RADIUS);
    }
    const picked = preview ? grab : hover;
    const inFrame = framed(list);
    for (const chosen of list)
      if (
        (selected.has(chosen.id) || hot === chosen.id) &&
        chosen.id !== picked?.id &&
        chosen !== inFrame
      )
        drawPicked(chosen, list, null);
    const mark = picked && list.find(({ id }) => id === picked.id);
    if (picked && mark && mark !== inFrame)
      drawPicked(
        mark,
        list,
        preview && grab?.handle !== undefined ? null : picked.index
      );
    const curve = tool === 'select' && editingCurve();
    if (curve && editing) {
      const drawn = list.find(({ id }) => id === curve.id);
      if (drawn?.type === 'curve') drawHandles(drawn, editing.index);
    }
    if (bendHover && !grab) ring(bendHover, 5);
    const frameBox = inFrame && boxOf(inFrame);
    if (frameBox) drawTextFrame(ctx, frameBox, host.accent(), ringFill());
    if (preview && grab?.index != null) {
      const at = pointsOf(preview[0])[grab.index];
      if (at) drawChip(ctx, numberText(at), ...screen(at), width);
    }
    host.trail.draw(ctx);
    if (boxing) {
      const { from, to } = boxing;
      ctx.fillStyle = 'rgba(30, 150, 235, 0.08)';
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1;
      ctx.fillRect(from[0], from[1], to[0] - from[0], to[1] - from[1]);
      ctx.strokeRect(from[0], from[1], to[0] - from[0], to[1] - from[1]);
    }
    if (
      !pointer ||
      grab ||
      tool === 'select' ||
      tool === 'erase' ||
      tool === 'label'
    )
      return;
    // Over a point, the next click lands on it (closing a curve on its first, say).
    const under = hover?.index != null && find(hover.id);
    const at =
      under && hover?.index != null
        ? pointsOf(under)[hover.index]
        : snapped(pointer);
    const open = openMark();
    if (open?.type === 'curve')
      stroke({ ...open, coords: [...open.coords, at] }, list, BLUE, 2);
    else if (open?.type === 'polyline')
      stroke(
        { ...open, coords: [...open.coords.slice(-1), at] },
        list,
        BLUE,
        2
      );
    ctx.strokeStyle = BLUE;
    ctx.fillStyle = BLUE;
    ctx.lineWidth = 2;
    const [ax, ay] = screen(at);
    if (sizing?.r) {
      // The circle being sized, and its radius.
      const [cx, cy] = screen(sizing.centre);
      const [rx, ry] = [sizing.r * view.ppuX, sizing.r * view.ppuY];
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      dot([cx, cy], 4.5);
      drawChip(
        ctx,
        `r = ${axisNumber(sizing.r, minors()[0])}`,
        cx + rx,
        cy,
        width
      );
      return;
    }
    if (tool === 'ellipse') {
      // The circle a click places.
      const r = tickStep(view.ppuX);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.ellipse(ax, ay, r * view.ppuX, r * view.ppuY, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const [ox, oy] = screen([0, 0]);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax, oy);
    ctx.moveTo(ax, ay);
    ctx.lineTo(ox, ay);
    ctx.stroke();
    ctx.setLineDash([]);
    dot([ax, ay], 4.5);
    drawChip(ctx, numberText(at), ax, ay, width);
  };

  /** The primary pointers down here; a second one hands the press to the gestures. */
  const pointers = new Map<number, Vec>();
  let pressed = false;
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const at = host.local(event);
    pointers.set(event.pointerId, at);
    if (pointers.size === 2) {
      pressed = false;
      pointer = null;
      grab = null;
      boxing = null;
      host.redraw();
      return;
    }
    pressed = true;
    pointer = at;
    if (tool === 'erase') {
      erasing = new Set();
      host.trail.start(at);
      eraseNear(at);
      host.redraw();
      return;
    }
    const pulled = !pointAt(at) && cornerAt(at);
    if (pulled) {
      grab = { ...pulled, index: null, preview: null, start: at };
      host.redraw();
      return;
    }
    const knob = knobAt(at);
    if (knob) {
      grab = {
        handle: knob.side,
        id: knob.id,
        index: knob.index,
        preview: null,
        start: at,
      };
      host.redraw();
      return;
    }
    const bending = bendAt(at);
    if (bending) {
      grab = {
        bend: bending.bend,
        id: bending.id,
        index: null,
        preview: null,
        start: at,
      };
      host.redraw();
      return;
    }
    const target = pickable(at);
    grab = target && { ...target, preview: null, start: at };
    if (tool === 'select' && !target)
      boxing = { adding: event.shiftKey, from: at, to: at };
    sizing =
      tool === 'ellipse' && !grab
        ? { centre: snapped(at), r: null, start: at }
        : null;
    host.redraw();
  };
  const move = (event: PointerEvent) => {
    const at = host.local(event);
    const last = pointers.get(event.pointerId);
    if (last) pointers.set(event.pointerId, at);
    // The gestures have a middle-button drag or a pinch.
    if (event.buttons & 4 || (last && pointers.size === 2)) return;
    if (erasing && last && pressed) {
      for (const px of alongDrag(last, at)) eraseNear(px);
      host.trail.add(at);
      pointer = at;
      host.redraw();
      return;
    }
    if (sizing && last && pressed) {
      if (
        sizing.r === null &&
        Math.hypot(at[0] - sizing.start[0], at[1] - sizing.start[1]) <
          PIXELS_TO_DRAG
      )
        return;
      const [x, y] = plane(at);
      const step = minors()[0];
      sizing.r = Math.max(
        step,
        snapTo(Math.hypot(x - sizing.centre[0], y - sizing.centre[1]), step)
      );
      host.redraw();
      return;
    }
    const picked = grab && find(grab.id);
    if (grab && picked && last && pressed) {
      if (
        !grab.preview &&
        Math.hypot(at[0] - grab.start[0], at[1] - grab.start[1]) <
          PIXELS_TO_DRAG
      )
        return;
      if (
        grab.corner !== undefined &&
        (picked.type === 'text' || picked.type === 'formula')
      ) {
        const plain = picked.type === 'text' ? LABEL_SIZE : FORMULA_SIZE;
        const size = draggedSize(
          picked.size ?? plain,
          screen(picked.coords),
          grab.start,
          at,
          TEXT_SIZES
        );
        // Back at the plain size it stores none, so a drag there and back is no step.
        const { size: _, ...unsized } = picked;
        grab.preview = [size === plain ? unsized : { ...picked, size }];
        canvas.style.cursor = CORNER_CURSOR[grab.corner];
        host.redraw();
        return;
      }
      if (
        grab.handle !== undefined &&
        grab.index !== null &&
        picked.type === 'curve'
      ) {
        grab.preview = [
          pulledHandle(
            picked,
            grab.index,
            grab.handle,
            plane(at),
            event.altKey
          ),
        ];
        canvas.style.cursor = 'grabbing';
        host.redraw();
        return;
      }
      if (grab.bend && picked.type === 'curve') {
        grab.preview = [bent(picked, grab.bend, plane(at))];
        canvas.style.cursor = 'grabbing';
        host.redraw();
        return;
      }
      // A formula row's curve is not dragged: its row is retyped.
      if (picked.type === 'expression') return;
      const [from, to] = [plane(grab.start), plane(at)];
      // A whole mark lands its first point (an ellipse its middle) on the grid, a polar
      // one's rings and spokes included, so one off it from before comes back. A label
      // goes where it's dragged, as it's placed where it's clicked (Epo 2026-11-13).
      const anchor =
        picked.type === 'ellipse'
          ? picked.center
          : (pointsOf(picked)[0] ?? points().get(namedPoints(picked)[0]));
      if (grab.index === null) {
        if (!anchor) return;
        const dragged: Vec = [
          anchor[0] + to[0] - from[0],
          anchor[1] + to[1] - from[1],
        ];
        const landed = picked.type === 'text' ? dragged : snapPlane(dragged);
        const by: Vec = [landed[0] - anchor[0], landed[1] - anchor[1]];
        // One of several selected marks takes them all along.
        grab.preview = movedGroup(
          elements(),
          selected.has(picked.id) ? selected : new Set([picked.id]),
          by
        );
      } else
        grab.preview = [moved(picked, grab.index, snapped(at), event.shiftKey)];
      canvas.style.cursor = 'grabbing';
      host.redraw();
      return;
    }
    if (boxing && last && pressed) {
      boxing.to = at;
      host.redraw();
      return;
    }
    const mouse = !last && event.pointerType === 'mouse';
    pointer = last || event.pointerType === 'mouse' ? at : null;
    hover = mouse ? pickable(at) : null;
    near = mouse ? (pointAt(at)?.id ?? markAt(at)?.id ?? null) : null;
    const knob = mouse && knobAt(at);
    bendHover = mouse && !knob ? (bendAt(at)?.at ?? null) : null;
    const corner = !last && cornerAt(at);
    canvas.style.cursor = corner
      ? CORNER_CURSOR[corner.corner]
      : hover || bendHover || knob
        ? 'grab'
        : '';
    host.redraw();
  };
  const up = (event: PointerEvent) => {
    if (event.button === 1) return;
    const was = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    const boxed = boxing;
    boxing = null;
    const held = grab;
    grab = null;
    canvas.style.cursor = '';
    const sized = sizing;
    sizing = null;
    const erased = erasing;
    erasing = null;
    if (erased) {
      host.trail.end();
      if (erased.size) remove(erased);
    } else if (sized && was && pressed) {
      // Dragged, the size it was dragged to; a click, a grid step round.
      addCircle(sized.centre, sized.r ?? tickStep(host.view().ppuX));
    } else if (held?.preview) {
      // Only what moved: a drag back to where it was writes nothing.
      const changed = held.preview.filter(
        (mark) => !sameJson(mark, find(mark.id))
      );
      if (changed.length)
        write(
          elements().map(
            (mark) => changed.find(({ id }) => id === mark.id) ?? mark
          )
        );
      if (tool === 'select' && !selected.has(held.id))
        selected = event.shiftKey
          ? new Set([...selected, held.id])
          : new Set([held.id]);
    } else if (boxed && pressed) {
      // A click on empty paper lets go; a box picks all it touches, Shift adding.
      const caught = elements()
        .filter(
          (mark) =>
            !mark.hidden &&
            touches(
              mark,
              boxed.from,
              boxed.to,
              host.view(),
              points(),
              ctx,
              LABEL_SIZE
            )
        )
        .map(({ id }) => id);
      const dragged =
        Math.hypot(boxed.to[0] - boxed.from[0], boxed.to[1] - boxed.from[1]) >=
        PIXELS_TO_DRAG;
      if (boxed.adding)
        selected = new Set([...selected, ...(dragged ? caught : [])]);
      else selected = new Set(dragged ? caught : []);
    } else if (was && pressed && tool === 'select' && held) {
      // A click picks the mark under it; with Shift it's added or taken away.
      const next = new Set(event.shiftKey ? selected : []);
      if (event.shiftKey && selected.has(held.id)) next.delete(held.id);
      else next.add(held.id);
      selected = next;
    } else if (was && pressed && tool !== 'select') {
      // A tap on a point does the tool's job right at it: Line starts from it.
      const mark = held && find(held.id);
      place(
        host.local(event),
        mark && held?.index != null ? pointsOf(mark)[held.index] : undefined
      );
    }
    // Select on a curve's point picks it, its handles showing; a handle or a bend
    // keeps it; anything else lets go.
    if (
      tool === 'select' &&
      pressed &&
      held?.handle === undefined &&
      !held?.bend
    ) {
      const mark = held && find(held.id);
      editing =
        held && mark?.type === 'curve' && held.index !== null
          ? { id: held.id, index: held.index }
          : null;
    }
    pressed = false;
    if (event.pointerType !== 'mouse') pointer = null;
    host.changed();
    host.redraw();
  };
  const cancel = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pressed = false;
    grab = null;
    sizing = null;
    erasing = null;
    boxing = null;
    host.trail.end();
    host.redraw();
  };
  const leave = () => {
    pointer = null;
    hover = null;
    near = null;
    bendHover = null;
    host.redraw();
  };
  // A double click on a curve's point makes it a corner, or smooth again (K1).
  // With Select, a double click on a label edits it and on empty paper places one,
  // as on the canvas (Epo 2026-11-13).
  const doubleClick = (event: MouseEvent) => {
    if (tool !== 'select') return;
    const px = host.local(event);
    const point = pointAt(px);
    const mark = point && find(point.id);
    if (!point) {
      const under = markAt(px);
      if (!under || under.type === 'text') {
        selected = new Set();
        editing = null;
        typeLabel(px);
        host.redraw();
      }
      return;
    }
    if (mark?.type !== 'curve') return;
    replace(toggledCorner(mark, point.index));
    editing = { id: mark.id, index: point.index };
    host.redraw();
  };

  const pick = (id: Tool) => {
    commitLabel();
    finish();
    hover = null;
    selected = new Set();
    editing = null;
    tool = id;
    host.changed();
  };

  return {
    /** Listens for the tools' presses on the canvas; returns the cleanup. */
    attach() {
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', cancel);
      canvas.addEventListener('pointerleave', leave);
      canvas.addEventListener('dblclick', doubleClick);
      return () => {
        canvas.removeEventListener('pointerdown', down);
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', cancel);
        canvas.removeEventListener('pointerleave', leave);
        canvas.removeEventListener('dblclick', doubleClick);
      };
    },
    /** Lets go of what is selected and being typed (Clear all). */
    clear() {
      typing = null;
      openId = null;
      selected = new Set();
      editing = null;
      hot = null;
    },
    commitLabel,
    /** Delete or Backspace: removes what's selected and what is built on it, true
     * when something was. */
    deleteSelected() {
      if (!elements().some(({ id }) => selected.has(id))) return false;
      remove(selected);
      selected = new Set();
      editing = null;
      host.changed();
      host.redraw();
      return true;
    },
    drawOverlay,
    /** Escape: ends the label being typed, lets go of the selection or ends the open
     * mark, in that order; false when there was none. */
    escape() {
      if (typing) {
        typing = null;
        host.changed();
        return true;
      }
      // Only what is still there counts: a row deleted from the list may
      // have left its id selected.
      if (elements().some(({ id }) => selected.has(id))) {
        selected = new Set();
        editing = null;
        host.changed();
        host.redraw();
        return true;
      }
      selected = new Set();
      if (!openMark()) return false;
      finish();
      return true;
    },
    finish,
    /** The open line's or curve's Finish button's text, when one is open. */
    finishLabel() {
      const open = openMark();
      return open?.type === 'curve'
        ? m.drawing_board_finish_curve()
        : open?.type === 'polyline' && !open.arrow
          ? m.drawing_board_finish_line()
          : null;
    },
    /** Leaving the editor: the label typed is written, and a line or curve with one
     * point goes. */
    leave() {
      commitLabel();
      openId = null;
      const list = elements();
      if (!list.every(whole)) write(list.filter(whole));
    },
    pick,
    /** Selects one element, as a click on it does (a label row's field
     * focused, Epo 2026-11-18). */
    select(id: string | null, add = false) {
      // Only under Select, as a click picks, and only what the graph holds;
      // null lets go of it all, as a click on nothing does.
      if (tool !== 'select') return;
      if (id && !elements().some((each) => each.id === id)) return;
      const next = new Set(add ? selected : []);
      if (id) next.add(id);
      if (!editing && sameSet(next, selected)) return;
      selected = next;
      editing = null;
      host.changed();
      host.redraw();
    },
    /** Whether a row's element is selected. */
    selected: (id: string) => selected.has(id),
    /** Lights a row's element on the graph, or none. */
    setHot(id: string | null) {
      if (hot === id) return;
      hot = id;
      host.redraw();
    },
    /** A tool's letter key (`P`), true when it was one. */
    shortcut(key: string) {
      const found = toolsFor(host.polar()).find((each) => each.key === key);
      if (found) pick(found.id);
      return Boolean(found);
    },
    shown,
    /** A pixel on the graph landed on its grid, as the tools land points. */
    snapped,
    tool: () => tool,
    typing: () => typing,
  };
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((each) => b.has(each));
