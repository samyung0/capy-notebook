import { ThemeProvider } from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import {
  AlertCircleIcon,
  Delete02Icon,
  LeftToRightListBulletIcon,
  MoreVerticalIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { html, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import type { MathfieldElement } from 'mathlive';
import { axisNumber } from '@/features/questions/graph';
import {
  type ParsedRow,
  parseRow,
  RowError,
} from '@/features/questions/graphSyntax';
import { tickStep } from '@/features/questions/graphTicks';
import mathFieldStyles from '@/features/questions/mathField.css?inline';
import { getLocale, m } from '@/i18n';
import {
  bezier,
  curveSegments,
  ellipseCentre,
  ellipseIn,
  functionRuns,
  isLoop,
  LABEL_LENGTH_MAX,
  MARKS_MAX,
  type Mark,
  markFunction,
  PAPER,
  type PathMark,
  pathOf,
  pointsOf,
  pullEllipse,
  smoothHandles,
} from './boardData';
import { drawChip, openBoardEditor, toolTip } from './boardEditorShell';
import { alongDrag, ERASER_SIZE, EraserTrail } from './boardEraser';
import { openFormulaCard, symbolButtons } from './boardFormula';
import { laidOut } from './boardFormulaDraw';
import { minorStep, snapTo, tidy, type Vec } from './boardGeometry';
import {
  arrowHead,
  drawPlane,
  fitCard,
  formulaBox,
  markPoints,
  type PlaneElementModel,
  type PlaneView,
  POLAR_SPOKE,
  type Span,
  setPlaneEditor,
  traceFunction,
  traceMark,
} from './boardPlane';
import { boardKindOf, hugeIcon, mathsIcon } from './boardTools';

type Tool =
  | 'select'
  | 'point'
  | 'line'
  | 'vector'
  | 'curve'
  | 'ellipse'
  | 'label'
  | 'formula'
  | 'erase';

/** How near a line, curve or ellipse a press with Select picks it. */
const PIXELS_TO_SELECT = 12;
const PIXELS_TO_LABEL = 24;
/** How near a point's dot a press picks it up, and how far it goes before it's a drag
 * rather than a tap. */
const PIXELS_TO_GRAB = 11;
const PIXELS_TO_DRAG = 4;
const BLUE = '#1e96eb';
const HALO = 'rgba(30, 150, 235, 0.18)';
/** A picked-up point's ring, filled solid over the see-through paper. */
const RING_FILL = { dark: '#252525', light: '#fff' };
const PPU_MIN = 1e-6;
const PPU_MAX = 1e6;
/** Fit's least span, in units, across and up (Epo 2026-11-13). */
const FIT_SPAN = 10;
/** How far from the origin the view goes, in the plane's units. */
const VIEW_MAX = 1e9;

/** Whether a mark has become what it set out to be. Leaving keeps what has, and removes
 * what hasn't, as AFFiNE removes a connector it cancels. */
const whole = (mark: Mark) => !('points' in mark) || mark.points.length > 1;

/** With their keys, shown in their tooltips (Epo 2026-11-08). */
const TOOLS: { icon: string; id: Tool; key: string; label: () => string }[] = [
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

/** The objects list's open or closed, as last chosen this session; until then open
 * on a wide screen and closed on a phone (Epo 2026-11-13, L2). */
let listChoice: boolean | null = null;
/** Under this width the list is a sheet over the plane's lower half. */
const SHEET_BELOW = 640;
/** The empty row at the end of the list, where a function or point is typed. */
const NEW_ROW = 'new';

const coordinate = (value: number) => String(tidy(value)).replace('-', '−');
const pairText = ([x, y]: Vec) => `(${coordinate(x)}, ${coordinate(y)})`;
/** The points typed in a row: `(2, 1)`, with either minus. */
const typedPairs = (text: string): Vec[] =>
  [
    ...text
      .replace(/[−–]/g, '-')
      .matchAll(/\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)/g),
  ].map((match) => [Number(match[1]), Number(match[2])]);

/** A mark's icon in the list, the tool that makes it. */
const ROW_ICON: Record<Mark['kind'], string> = {
  curve: 'curve',
  dot: 'point',
  ellipse: 'ellipse',
  formula: 'formula',
  function: 'function',
  label: 'label',
  line: 'line',
  vector: 'vector',
};

/** Whether segment ab crosses segment cd. */
function crosses(a: Vec, b: Vec, c: Vec, d: Vec) {
  const side = (p: Vec, q: Vec, r: Vec) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

/** How far a mark is from a point on the plane, in plane units. A function is only
 * looked for within `reach` across, where any of it in reach must be. */
function distanceTo(mark: Mark, [x, y]: Vec, reach = 1) {
  if (mark.kind === 'function')
    return Math.min(
      Number.POSITIVE_INFINITY,
      ...functionRuns(
        mark,
        x - reach,
        x + reach,
        reach / 16,
        Number.POSITIVE_INFINITY
      ).map((run) => alongPath(run, [x, y]))
    );
  if (!('points' in mark)) return Math.hypot(x - mark.at[0], y - mark.at[1]);
  return alongPath(pathOf(mark), [x, y]);
}

/** How far a point is from a path of straight steps. */
function alongPath(points: Vec[], [x, y]: Vec) {
  const between = (a: Vec, b: Vec) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = dx * dx + dy * dy;
    const t = length
      ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length))
      : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  return points.length > 1
    ? Math.min(...points.slice(1).map((p, i) => between(points[i], p)))
    : Math.hypot(x - points[0][0], y - points[0][1]);
}

const same = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;

/** Whether a point's two handles lie on one line through it, so pulling one turns
 * the other (a smooth point); an end, with one handle, counts as smooth. */
function smoothAt(point: Vec, [into, out]: [Vec, Vec]) {
  if (same(into, point) || same(out, point)) return true;
  const a = Math.atan2(point[1] - into[1], point[0] - into[0]);
  const b = Math.atan2(out[1] - point[1], out[0] - point[0]);
  const turn = Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  return turn < 0.05;
}

/** A point's [in, out] handles. A loop's seam is one point drawn as its first and
 * last: its in-handle is the last one's and its out-handle the first one's. */
function pairOf(
  handles: [Vec, Vec][],
  index: number,
  loop: boolean
): [Vec, Vec] {
  const last = handles.length - 1;
  return loop && (index === 0 || index === last)
    ? [handles[last][0], handles[0][1]]
    : [handles[index][0], handles[index][1]];
}
function putPair(
  handles: [Vec, Vec][],
  index: number,
  loop: boolean,
  pair: [Vec, Vec]
) {
  if (loop && (index === 0 || index === handles.length - 1)) {
    handles[0] = [pair[0], pair[1]];
    handles[handles.length - 1] = [pair[0], pair[1]];
  } else handles[index] = pair;
}

/** `handles[index]`'s other handle turned to stay on the line through its point, at
 * its own length. */
function turnOther(point: Vec, pair: [Vec, Vec], moved: 0 | 1) {
  const other = moved ? 0 : 1;
  const length = Math.hypot(
    pair[other][0] - point[0],
    pair[other][1] - point[1]
  );
  const [dx, dy] = [point[0] - pair[moved][0], point[1] - pair[moved][1]];
  const away = Math.hypot(dx, dy);
  if (!length || !away) return;
  pair[other] = [
    point[0] + (dx / away) * length,
    point[1] + (dy / away) * length,
  ];
}

/** A curve with one handle of a point pulled to `to`. A smooth point's other handle
 * turns with it, unless `alone` (Alt), which leaves a corner (Epo 2026-11-13, K1). */
function pulledHandle(
  mark: PathMark,
  index: number,
  side: 0 | 1,
  to: Vec,
  alone: boolean
): PathMark {
  const handles = (mark.handles ?? smoothHandles(mark.points)).map(
    ([a, b]): [Vec, Vec] => [a, b]
  );
  const loop = isLoop(mark.points);
  const point = mark.points[index];
  const pair = pairOf(handles, index, loop);
  const smooth = !alone && smoothAt(point, pair);
  pair[side] = to;
  if (smooth) turnOther(point, pair, side);
  putPair(handles, index, loop, pair);
  return { ...mark, handles };
}

/** A press on a curve's stroke, between its points: piece `piece` at `t`, with the
 * handles as they were. */
type Bend = { from: Vec; handles: [Vec, Vec][]; piece: number; t: number };

/** The curve with piece `bend.piece` pulled through the pointer at its `t`, its two
 * inner handles moving by their share and its points staying smooth (Epo
 * 2026-11-13, K2). */
function bent(mark: PathMark, bend: Bend, to: Vec): PathMark {
  const t = Math.min(0.9, Math.max(0.1, bend.t));
  const u = 1 - t;
  const k = 1 / (3 * t * u * (u * u + t * t));
  const [dx, dy] = [to[0] - bend.from[0], to[1] - bend.from[1]];
  const handles = bend.handles.map(([a, b]): [Vec, Vec] => [a, b]);
  const loop = isLoop(mark.points);
  const { piece } = bend;
  const [start, end] = [
    pairOf(handles, piece, loop),
    pairOf(handles, piece + 1, loop),
  ];
  const smooth = [
    smoothAt(mark.points[piece], pairOf(bend.handles, piece, loop)),
    smoothAt(mark.points[piece + 1], pairOf(bend.handles, piece + 1, loop)),
  ];
  start[1] = [start[1][0] + dx * k * u, start[1][1] + dy * k * u];
  end[0] = [end[0][0] + dx * k * t, end[0][1] + dy * k * t];
  if (smooth[0]) turnOther(mark.points[piece], start, 1);
  if (smooth[1]) turnOther(mark.points[piece + 1], end, 0);
  putPair(handles, piece, loop, start);
  putPair(handles, piece + 1, loop, end);
  return { ...mark, handles };
}

/** A mark with one of its points at `to`, or (`index` null) all of it moved by `to`. */
function moved(
  mark: Mark,
  index: number | null,
  to: Vec,
  uniform: boolean
): Mark {
  // A function stays where its expression puts it: its row changes it.
  if (mark.kind === 'function') return mark;
  if (index !== null) {
    if (mark.kind === 'ellipse')
      return { ...mark, points: pullEllipse(mark.points, index, to, uniform) };
    if (!('points' in mark)) return { ...mark, at: to };
    // A point takes its handles along.
    const from = mark.points[index];
    const shift = (p: Vec): Vec => [
      p[0] + to[0] - from[0],
      p[1] + to[1] - from[1],
    ];
    return {
      ...mark,
      ...(mark.handles && {
        handles: mark.handles.map((pair, i): [Vec, Vec] =>
          i === index ? [shift(pair[0]), shift(pair[1])] : pair
        ),
      }),
      points: mark.points.map((p, i) => (i === index ? to : p)),
    };
  }
  const by = (p: Vec): Vec => [tidy(p[0] + to[0]), tidy(p[1] + to[1])];
  return 'points' in mark
    ? {
        ...mark,
        ...(mark.handles && {
          handles: mark.handles.map(([a, b]): [Vec, Vec] => [by(a), by(b)]),
        }),
        points: mark.points.map(by),
      }
    : { ...mark, at: by(mark.at) };
}

/** The endless plane, filling the board for editing. Everything plotted is written at
 * once, so undo steps through it click by click; the view is written on leaving. Escape
 * ends the open mark, or leaves as Done does when there's none. */
function openPlaneEditor(gfx: GfxController, model: PlaneElementModel) {
  const theme = gfx.std.get(ThemeProvider);
  /** The line or curve still taking clicks. Undo simply shortens it. */
  let openId: string | null = null;
  const openMark = () => model.marks.find((mark) => mark.id === openId);
  /** The label being typed, at its point on the plane; `id` when it's an old one. */
  let typing: { at: Vec; id?: string; text: string } | null = null;
  let frame = 0;
  /** The menu's zoom counts from the card's scale on the canvas as 100% (Epo 2026-11-09). */
  const cardPpu = model.ppu;

  const shell = openBoardEditor(gfx, model.id, {
    clear: {
      empty: () => !model.marks.length,
      run: () => {
        typing = null;
        openId = null;
        fresh = null;
        drafts.clear();
        rowErrors.clear();
        selected = new Set();
        editing = null;
        hot = null;
        menuFor = null;
        write([]);
        drawControls();
        redraw();
      },
    },
    fit: () => fitMarks(),
    onDelete: () => {
      if (!model.marks.some(({ id }) => selected.has(id))) return false;
      write(model.marks.filter(({ id }) => !selected.has(id)));
      selected = new Set();
      editing = null;
      redraw();
      return true;
    },
    onEscape: () => {
      if (menuFor) {
        menuFor = null;
        drawControls();
        return true;
      }
      // A row being typed in lets go first, back as it was.
      const field = document.activeElement;
      const row = field?.closest<HTMLElement>('.capy-plane-list [data-row]');
      if (
        row?.dataset.row &&
        (field instanceof HTMLInputElement || field?.localName === 'math-field')
      ) {
        discardRow(row.dataset.row);
        (field as HTMLElement).blur();
        return true;
      }
      if (typing) {
        typing = null;
        drawControls();
        return true;
      }
      if (selected.size) {
        selected = new Set();
        editing = null;
        drawControls();
        redraw();
        return true;
      }
      if (!openMark()) return false;
      finish();
      return true;
    },
    onLeave: () => {
      commitLabel();
      for (const key of [...drafts.keys(), ...(fresh ? [NEW_ROW] : [])])
        commitRow(key);
      openId = null;
      const kept = model.marks.filter(whole);
      if (kept.length < model.marks.length)
        shell?.write(() =>
          gfx.surface?.updateElement(model.id, { marks: kept })
        );
      const { height, width } = box();
      const [x, y] = [
        view.x0 + width / 2 / view.ppu,
        view.y0 - height / 2 / view.ppu,
      ];
      const [, , w, h] = model.deserializedXYWH;
      // The view is where the student looks, not part of the undo history.
      gfx.doc.withoutTransact(() => {
        model.ppu = view.ppu;
        model.x0 = x - w / 2 / view.ppu;
        model.y0 = y + h / 2 / view.ppu;
      });
      if (model.fit) fitCard(model);
      cancelAnimationFrame(frame);
    },
    onShortcut: (key) => {
      const found = tools().find((each) => each.key === key);
      if (found) pick(found.id);
      return !!found;
    },
    onUpdate: () => {
      drawControls();
      redraw();
    },
    zoom: {
      in: () => zoomCentre(1.5),
      out: () => zoomCentre(1 / 1.5),
      percent: {
        reset: () => zoomCentre(cardPpu / view.ppu),
        value: () => view.ppu / cardPpu,
      },
    },
  });
  if (!shell) return;
  const { box, canvas, controls, ctx, root } = shell;

  const [, , cardW, cardH] = model.deserializedXYWH;
  const start = box();
  const centre: Vec = [
    model.x0 + cardW / 2 / model.ppu,
    model.y0 - cardH / 2 / model.ppu,
  ];
  const view: PlaneView = {
    polar: model.polar,
    ppu: model.ppu,
    x0: centre[0] - start.width / 2 / model.ppu,
    y0: centre[1] + start.height / 2 / model.ppu,
  };
  let tool: Tool = 'select';
  /** Where the pointer is, in pixels on this canvas, while it means something. */
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
  const trail = new EraserTrail(() => redraw());
  /** The line, curve or ellipse under the mouse, whose points show (Epo 2026-11-08). */
  let near: string | null = null;
  /** The press on a mark: a tap does the tool's job, a drag moves it. Until it lifts the
   * moved copy is only drawn, so the drag is one undo step. */
  /** A new circle being sized: pressed at its middle, its radius from the drag. */
  let sizing: { centre: Vec; r: number | null; start: Vec } | null = null;
  /** `preview` holds the moved copies: the mark, or every selected one when it's one
   * of them. */
  let grab: {
    id: string;
    index: number | null;
    preview: Mark[] | null;
    start: Vec;
    /** A picked point's handle being pulled: in (0) or out (1). */
    handle?: 0 | 1;
    /** The selected curve's stroke being pulled. */
    bend?: Bend;
  } | null = null;
  /** The curve point whose handles show, picked with Select (Epo 2026-11-13, K1). */
  let editing: { id: string; index: number } | null = null;
  /** Where a press would bend the selected curve, under the mouse, in pixels. */
  let bendHover: Vec | null = null;
  const workspace = boardKindOf(gfx.std) === 'workspace';
  /** Rows typed but not yet written: a function as it's typed, drawn meanwhile. */
  const drafts = new Map<string, Mark>();
  const rowErrors = new Map<string, string>();
  /** What the empty row would add, as typed so far. */
  let fresh: Mark | null = null;
  /** The row under the mouse, its mark lit on the plane. */
  let hot: string | null = null;
  /** The row whose ⋮ menu is open, and how far down the list it sits. */
  let menuFor: { id: string; top: number } | null = null;
  /** The row to focus once the list has drawn it (a label just added). */
  let focusRow: string | null = null;
  const fields = new Map<string, MathfieldElement>();
  let Mathfield: typeof MathfieldElement | null = null;

  const toPlane = ([px, py]: Vec): Vec => [
    view.x0 + px / view.ppu,
    view.y0 - py / view.ppu,
  ];
  const minor = () => minorStep(tickStep(view.ppu));
  const screenAxes = () =>
    [
      (x: number) => (x - view.x0) * view.ppu,
      (y: number) => (view.y0 - y) * view.ppu,
    ] as const;
  const toScreen = ([x, y]: Vec): Vec => [
    (x - view.x0) * view.ppu,
    (view.y0 - y) * view.ppu,
  ];
  const span = (): Span => {
    const { height, width } = box();
    return {
      height,
      left: view.x0,
      ppu: view.ppu,
      right: view.x0 + width / view.ppu,
    };
  };
  /** The point whose dot is under a pixel. */
  const pointAt = (px: Vec) => {
    let best: { id: string; index: number } | null = null;
    let reach = PIXELS_TO_GRAB;
    for (const mark of model.marks) {
      if (mark.kind === 'label' || mark.kind === 'formula') continue;
      for (const [index, point] of pointsOf(mark).entries()) {
        const [x, y] = toScreen(point);
        const distance = Math.hypot(x - px[0], y - px[1]);
        if (distance <= reach) {
          reach = distance;
          best = { id: mark.id, index };
        }
      }
    }
    return best;
  };
  /** The line, curve or label under a pixel. */
  /** Whether a pixel is on a formula: its laid-out box, or near its point until then. */
  const onFormula = (mark: Extract<Mark, { kind: 'formula' }>, px: Vec) => {
    const [x, y] = toScreen(mark.at);
    const drawn = laidOut(mark.latex);
    if (!drawn) return Math.hypot(px[0] - x, px[1] - y) <= PIXELS_TO_LABEL;
    const box = formulaBox(drawn, x, y);
    return (
      px[0] >= box.x - 4 &&
      px[0] <= box.x + box.w + 4 &&
      px[1] >= box.y - 4 &&
      px[1] <= box.y + box.h + 4
    );
  };
  const markAt = (px: Vec) => {
    const here = toPlane(px);
    return model.marks.find((mark) => {
      if (mark.kind === 'formula') return onFormula(mark, px);
      if (mark.kind === 'dot') return false;
      const reach =
        (mark.kind === 'label' ? PIXELS_TO_LABEL : PIXELS_TO_SELECT) / view.ppu;
      return distanceTo(mark, here, reach) <= reach;
    });
  };
  /** Whether a mark has any part inside a box of pixels, as the board's selection box
   * picks what it touches. */
  const touches = (mark: Mark, [ax, ay]: Vec, [bx, by]: Vec) => {
    const [x0, x1, y0, y1] = [
      Math.min(ax, bx),
      Math.max(ax, bx),
      Math.min(ay, by),
      Math.max(ay, by),
    ];
    const inside = ([x, y]: Vec) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    if (mark.kind === 'formula') {
      const drawn = laidOut(mark.latex);
      if (!drawn) return inside(toScreen(mark.at));
      const f = formulaBox(drawn, ...toScreen(mark.at));
      return f.x <= x1 && f.x + f.w >= x0 && f.y <= y1 && f.y + f.h >= y0;
    }
    if (mark.kind === 'function')
      return functionRuns(
        mark,
        toPlane([x0, 0])[0],
        toPlane([x1, 0])[0],
        2 / view.ppu,
        Number.POSITIVE_INFINITY
      ).some((run) => run.some((point) => inside(toScreen(point))));
    const path = ('points' in mark ? pathOf(mark) : [mark.at]).map(toScreen);
    if (path.some(inside)) return true;
    const corners: Vec[] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    return path
      .slice(1)
      .some((b, i) =>
        corners.some((c, j) => crosses(path[i], b, c, corners[(j + 1) % 4]))
      );
  };
  const pickable = (px: Vec) => {
    if (tool === 'erase') return null;
    const point = pointAt(px);
    // With Select a single point takes its whole mark, so several selected dots move
    // together. A line's or curve's point stays its own, selected or not (Epo
    // 2026-11-13); its stroke drags the whole mark.
    if (
      point &&
      tool === 'select' &&
      model.marks.find(({ id }) => id === point.id)?.kind === 'dot'
    )
      return { id: point.id, index: null };
    if (point) return point;
    const mark = tool === 'select' ? markAt(px) : undefined;
    return mark ? { id: mark.id, index: null } : null;
  };
  const editingCurve = () => {
    const mark = editing && model.marks.find(({ id }) => id === editing?.id);
    return mark?.kind === 'curve' &&
      editing &&
      editing.index < mark.points.length
      ? mark
      : null;
  };
  const handlesOf = (mark: PathMark) =>
    mark.handles ?? smoothHandles(mark.points);
  /** The picked point's handle under a pixel. */
  const knobAt = (px: Vec) => {
    const mark = editingCurve();
    if (!mark || !editing || tool !== 'select') return null;
    const point = mark.points[editing.index];
    const pair = pairOf(handlesOf(mark), editing.index, isLoop(mark.points));
    for (const side of [0, 1] as const) {
      if (same(pair[side], point)) continue;
      const [x, y] = toScreen(pair[side]);
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
    const mark = model.marks.find((each) => each.id === id);
    // Any mark's point under the press is grabbed rather than the stroke bent.
    if (mark?.kind !== 'curve' || pointAt(px)) return null;
    let best: { at: Vec; d: number; piece: number; t: number } | null = null;
    for (const [piece, segment] of curveSegments(mark).entries())
      for (let step = 1; step < 48; step++) {
        const t = step / 48;
        const at = toScreen(bezier(segment, t));
        const d = Math.hypot(at[0] - px[0], at[1] - px[1]);
        if (d <= PIXELS_TO_SELECT && (!best || d < best.d))
          best = { at, d, piece, t };
      }
    if (!best) return null;
    const bend: Bend = {
      from: toPlane(px),
      handles: handlesOf(mark),
      piece: best.piece,
      t: best.t,
    };
    return { at: best.at, bend, id };
  };
  /** To grid points; on a polar plane, to where a ring crosses a spoke. */
  const snapPlane = ([x, y]: Vec): Vec => {
    const step = minor();
    if (!view.polar) return [snapTo(x, step), snapTo(y, step)];
    const r = snapTo(Math.hypot(x, y), step);
    const spoke = (POLAR_SPOKE * Math.PI) / 180;
    const t = snapTo(Math.atan2(y, x), spoke);
    return [r * Math.cos(t), r * Math.sin(t)];
  };
  const snapped = (px: Vec) => snapPlane(toPlane(px));

  const write = (marks: Mark[]) =>
    shell.write(() => gfx.surface?.updateElement(model.id, { marks }));
  const add = (mark: Mark) => {
    if (model.marks.length < MARKS_MAX) write([...model.marks, mark]);
  };
  const replaceOpen = (mark: Mark) =>
    write(model.marks.map((old) => (old.id === mark.id ? mark : old)));

  /** The mark under the pointer or being dragged, in blue with its point ringed. */
  const drawPicked = (mark: Mark, ringed: number | null) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (mark.kind === 'function') {
      for (const [colour, width] of [
        [HALO, 10],
        [BLUE, 2],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        traceFunction(ctx, mark, ...screenAxes(), span());
        ctx.stroke();
      }
      return;
    }
    if ('points' in mark) {
      for (const [colour, width] of [
        [HALO, 10],
        [BLUE, 2],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        traceMark(ctx, mark, ...screenAxes());
        ctx.stroke();
      }
      if (mark.kind === 'vector') {
        ctx.fillStyle = BLUE;
        arrowHead(ctx, mark, ...screenAxes());
      }
    }
    if (mark.kind === 'formula') {
      const drawn = laidOut(mark.latex);
      if (!drawn) return;
      const box = formulaBox(drawn, ...toScreen(mark.at));
      ctx.fillStyle = HALO;
      ctx.fillRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
      return;
    }
    if (mark.kind === 'label') {
      const [x, y] = toScreen(mark.at);
      ctx.font = '15px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(mark.text).width + 12;
      ctx.fillStyle = HALO;
      ctx.fillRect(x - w / 2, y - 12, w, 24);
      ctx.fillStyle = BLUE;
      ctx.fillText(mark.text, x, y);
      return;
    }
    for (const [i, point] of pointsOf(mark).entries()) {
      const [x, y] = toScreen(point);
      ctx.beginPath();
      if (i === ringed) {
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = RING_FILL[theme.theme];
        ctx.fill();
        ctx.strokeStyle = BLUE;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
      } else ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = BLUE;
      ctx.fill();
    }
  };

  const ring = ([x, y]: Vec, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = RING_FILL[theme.theme];
    ctx.fill();
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  /** The picked curve point's handles: a line out to each, a square at its end. */
  const drawHandles = (mark: PathMark, index: number) => {
    const point = mark.points[index];
    const at = toScreen(point);
    for (const handle of pairOf(handlesOf(mark), index, isLoop(mark.points))) {
      if (same(handle, point)) continue;
      const [x, y] = toScreen(handle);
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(...at);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = RING_FILL[theme.theme];
      ctx.fillRect(x - 4.5, y - 4.5, 9, 9);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
    ring(at, 6);
  };

  const draw = () => {
    const { height, width } = shell.sizeCanvas();
    const preview = grab?.preview;
    const marks = [
      ...model.marks.map(
        (mark) =>
          preview?.find(({ id }) => id === mark.id) ??
          drafts.get(mark.id) ??
          mark
      ),
      ...(fresh ? [fresh] : []),
    ].filter(({ id }) => !erasing?.has(id));
    drawPlane(
      ctx,
      { h: height, w: width, x: 0, y: 0 },
      view,
      marks,
      PAPER[theme.theme],
      // The open mark's points, and those of the mark under the pointer or held.
      new Set(
        [openId, near, grab?.id, ...selected].filter((id): id is string => !!id)
      ),
      redraw
    );
    const picked = preview ? grab : hover;
    for (const chosen of marks)
      if (
        (selected.has(chosen.id) || hot === chosen.id) &&
        chosen.id !== picked?.id
      )
        drawPicked(chosen, null);
    const mark = picked && marks.find(({ id }) => id === picked.id);
    if (picked && mark)
      drawPicked(
        mark,
        preview && grab?.handle !== undefined ? null : picked.index
      );
    const curve = tool === 'select' && editingCurve();
    if (curve && editing) {
      const shown = marks.find(({ id }) => id === curve.id);
      if (shown?.kind === 'curve') drawHandles(shown, editing.index);
    }
    if (bendHover && !grab) ring(bendHover, 5);
    if (preview && grab?.index != null) {
      const [x, y] = pointsOf(preview[0])[grab.index];
      const [sx, sy] = toScreen([x, y]);
      drawChip(
        ctx,
        `(${axisNumber(x, minor()) || 0}, ${axisNumber(y, minor()) || 0})`,
        sx,
        sy,
        width
      );
    }
    trail.draw(ctx);
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
    const X = (x: number) => (x - view.x0) * view.ppu;
    const Y = (y: number) => (view.y0 - y) * view.ppu;
    ctx.strokeStyle = '#1e96eb';
    ctx.fillStyle = '#1e96eb';
    ctx.lineWidth = 2;
    // Over a point, the next click lands on it (closing a curve on its first, say).
    const under =
      hover?.index != null && model.marks.find(({ id }) => id === hover?.id);
    const at =
      under && hover?.index != null
        ? pointsOf(under)[hover.index]
        : snapped(pointer);
    const open = openMark();
    if (open && 'points' in open) {
      const next =
        open.kind === 'curve'
          ? { ...open, points: [...open.points, at] }
          : { ...open, points: [...open.points.slice(-1), at] };
      traceMark(ctx, next, X, Y);
      ctx.stroke();
      if (open.kind === 'vector') arrowHead(ctx, next, X, Y);
    }
    if (sizing?.r) {
      // The circle being sized, and its radius.
      const [cx, cy] = sizing.centre;
      const r = sizing.r * view.ppu;
      ctx.beginPath();
      ctx.ellipse(X(cx), Y(cy), r, r, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X(cx), Y(cy), 4.5, 0, Math.PI * 2);
      ctx.fill();
      drawChip(
        ctx,
        `r = ${axisNumber(sizing.r, minor())}`,
        X(cx) + r,
        Y(cy),
        width
      );
      return;
    }
    if (tool === 'ellipse') {
      // The circle a click places.
      const r = tickStep(view.ppu) * view.ppu;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.ellipse(X(at[0]), Y(at[1]), r, r, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(at[0]), Y(at[1]));
    ctx.lineTo(X(at[0]), Y(0));
    ctx.moveTo(X(at[0]), Y(at[1]));
    ctx.lineTo(X(0), Y(at[1]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(X(at[0]), Y(at[1]), 4.5, 0, Math.PI * 2);
    ctx.fill();
    drawChip(
      ctx,
      `(${axisNumber(at[0], minor()) || 0}, ${axisNumber(at[1], minor()) || 0})`,
      X(at[0]),
      Y(at[1]),
      width
    );
  };
  const redraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  const newId = () => crypto.randomUUID();
  /** Ends the open mark. Like AFFiNE's shape and connector tools, the tool then goes
   * back to the plain one; Point stays on, like AFFiNE's pen, as it never opens one. */
  const finish = () => {
    const open = openMark();
    openId = null;
    if (open && !whole(open))
      write(model.marks.filter((mark) => mark.id !== open.id));
    tool = 'select';
    pointer = null;
    drawControls();
    redraw();
  };
  /** A circle round `at`; its handles stretch it into an ellipse. */
  const addCircle = (at: Vec, r: number) => {
    add({
      id: newId(),
      kind: 'ellipse',
      points: ellipseIn(at[0] - r, at[0] + r, at[1] - r, at[1] + r),
    });
    finish();
  };
  /** A press lands where it lifts, so a finger can line it up against the chip. */
  const place = (px: Vec, exact?: Vec) => {
    const at = exact ?? snapped(px);
    const open = openMark();
    if (tool === 'point') add({ at, id: newId(), kind: 'dot' });
    else if (tool === 'ellipse') addCircle(at, tickStep(view.ppu));
    else if (tool === 'line' || tool === 'vector' || tool === 'curve') {
      if (open?.kind === tool) {
        const last = open.points.at(-1);
        if (last?.[0] === at[0] && last[1] === at[1]) {
          finish();
          return;
        }
        replaceOpen({ ...open, points: [...open.points, at] });
        const [first] = open.points;
        const closes =
          open.points.length > 2 && first[0] === at[0] && first[1] === at[1];
        // A line or vector ends at its second point, a curve once it closes on its first.
        if (tool !== 'curve' || closes) finish();
        return;
      }
      if (model.marks.length >= MARKS_MAX) return;
      openId = newId();
      add({ id: openId, kind: tool, points: [at] });
    } else if (tool === 'label') typeLabel(px);
    else if (tool === 'formula') {
      // A click on a formula opens it again; elsewhere a new one goes where it was
      // clicked. One formula, then back to Select.
      const near = model.marks.find(
        (mark): mark is Extract<Mark, { kind: 'formula' }> =>
          mark.kind === 'formula' && onFormula(mark, px)
      );
      const at = near?.at ?? toPlane(px);
      if (!near && model.marks.length >= MARKS_MAX) return;
      tool = 'select';
      drawControls();
      void openFormulaCard(gfx, near?.latex ?? '', (latex) => {
        if (latex) {
          const formula: Mark = {
            at,
            id: near?.id ?? newId(),
            kind: 'formula',
            latex,
          };
          write(
            near
              ? model.marks.map((mark) =>
                  mark.id === near.id ? formula : mark
                )
              : [...model.marks, formula]
          );
        } else if (near)
          write(model.marks.filter((mark) => mark.id !== near.id));
      });
    }
  };

  /** Every mark within the eraser's ring round a pixel joins what it's erasing. */
  const eraseNear = (px: Vec) => {
    const here = toPlane(px);
    for (const mark of model.marks)
      if (
        mark.kind === 'formula'
          ? onFormula(mark, px)
          : distanceTo(mark, here, ERASER_SIZE / 2 / view.ppu) <=
            ERASER_SIZE / 2 / view.ppu
      )
        erasing?.add(mark.id);
  };

  /** Opens a label for typing: the one near `px`, or a new one right there. */
  const typeLabel = (px: Vec) => {
    commitLabel();
    const here = toPlane(px);
    const near = model.marks.find(
      (mark) =>
        mark.kind === 'label' &&
        distanceTo(mark, here) <= PIXELS_TO_LABEL / view.ppu
    );
    if (near?.kind === 'label')
      typing = { at: near.at, id: near.id, text: near.text };
    else if (model.marks.length < MARKS_MAX) typing = { at: here, text: '' };
    drawControls();
    controls.querySelector<HTMLInputElement>('.capy-chart-label')?.select();
  };
  /** A symbol from the row typed where the label's caret is, within its length. */
  const insertSymbol = (symbol: string) => {
    const field = controls.querySelector<HTMLInputElement>('.capy-chart-label');
    if (!field) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    if (field.value.length - (end - start) + symbol.length > LABEL_LENGTH_MAX)
      return;
    field.setRangeText(symbol, start, end, 'end');
  };
  const commitLabel = () => {
    const field = controls.querySelector<HTMLInputElement>('.capy-chart-label');
    const open = typing;
    typing = null;
    if (!open || !field) return;
    const text = field.value.trim();
    const others = model.marks.filter((mark) => mark.id !== open.id);
    if (text) {
      const label: Mark = {
        at: open.at,
        id: open.id ?? newId(),
        kind: 'label',
        text,
      };
      if (!open.id) write([...model.marks, label]);
      else if (text !== open.text)
        write(model.marks.map((mark) => (mark.id === open.id ? label : mark)));
    } else if (open.id) write(others);
    // One label, then back to Select, as the other tools do.
    if (tool === 'label') tool = 'select';
    drawControls();
  };

  const hold = () => {
    view.x0 = Math.max(-VIEW_MAX, Math.min(VIEW_MAX, view.x0));
    view.y0 = Math.max(-VIEW_MAX, Math.min(VIEW_MAX, view.y0));
    redraw();
  };
  const zoomAt = (factor: number, [px, py]: Vec) => {
    const [x, y] = toPlane([px, py]);
    view.ppu = Math.max(PPU_MIN, Math.min(PPU_MAX, view.ppu * factor));
    view.x0 = x - px / view.ppu;
    view.y0 = y + py / view.ppu;
    hold();
  };
  const zoomCentre = (factor: number) => {
    const { height, width } = box();
    zoomAt(factor, [width / 2, height / 2]);
  };
  const panBy = (dx: number, dy: number) => {
    view.x0 -= dx / view.ppu;
    view.y0 += dy / view.ppu;
    hold();
  };
  const fitMarks = () => {
    const seen = markPoints(model.marks);
    const xs = seen.map(([x]) => x);
    const ys = seen.map(([, y]) => y);
    const { height, width } = box();
    const [x0, x1, y0, y1] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
    ];
    // At least FIT_SPAN units each way, so a plane with nothing (or one point near
    // the origin) shows a stretch of grid rather than one unit across the screen.
    view.ppu = Math.max(
      PPU_MIN,
      Math.min(
        PPU_MAX,
        (width - 100) / Math.max(x1 - x0, FIT_SPAN),
        (height - 160) / Math.max(y1 - y0, FIT_SPAN)
      )
    );
    view.x0 = (x0 + x1) / 2 - width / 2 / view.ppu;
    view.y0 = (y0 + y1) / 2 + height / 2 / view.ppu;
    hold();
  };

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = box();
      const at: Vec = [event.clientX - rect.left, event.clientY - rect.top];
      if (event.ctrlKey || event.metaKey)
        zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), at);
      else panBy(-event.deltaX, -event.deltaY);
    },
    { passive: false }
  );

  const pointers = new Map<number, Vec>();
  let pinch = 0;
  let pressed = false;
  /** A middle-button drag pans, as on the board. */
  let panning = false;
  const local = (event: MouseEvent): Vec => {
    const rect = box();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  // The middle button pans here rather than starting the browser's autoscroll.
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button > 1) return;
    canvas.setPointerCapture(event.pointerId);
    const at = local(event);
    pointers.set(event.pointerId, at);
    if (event.button === 1) {
      panning = true;
      return;
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      pressed = false;
      pointer = null;
      grab = null;
      redraw();
      return;
    }
    pressed = true;
    pointer = at;
    if (tool === 'erase') {
      erasing = new Set();
      trail.start(at);
      eraseNear(at);
      redraw();
      return;
    }
    if (menuFor) {
      menuFor = null;
      drawControls();
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
      redraw();
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
      redraw();
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
    redraw();
  });
  canvas.addEventListener('pointermove', (event) => {
    const at = local(event);
    const last = pointers.get(event.pointerId);
    if (last) pointers.set(event.pointerId, at);
    if (panning && last) {
      panBy(at[0] - last[0], at[1] - last[1]);
      return;
    }
    if (last && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch)
        zoomAt(distance / pinch, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      panBy((at[0] - last[0]) / 2, (at[1] - last[1]) / 2);
      pinch = distance;
      return;
    }
    if (erasing && last && pressed) {
      for (const px of alongDrag(last, at)) eraseNear(px);
      trail.add(at);
      pointer = at;
      redraw();
      return;
    }
    if (sizing && last && pressed) {
      if (
        sizing.r === null &&
        Math.hypot(at[0] - sizing.start[0], at[1] - sizing.start[1]) <
          PIXELS_TO_DRAG
      )
        return;
      const [x, y] = toPlane(at);
      const step = minor();
      sizing.r = Math.max(
        step,
        snapTo(Math.hypot(x - sizing.centre[0], y - sizing.centre[1]), step)
      );
      redraw();
      return;
    }
    const picked = grab && model.marks.find(({ id }) => id === grab?.id);
    if (grab && picked && last && pressed) {
      if (
        !grab.preview &&
        Math.hypot(at[0] - grab.start[0], at[1] - grab.start[1]) <
          PIXELS_TO_DRAG
      )
        return;
      if (
        grab.handle !== undefined &&
        grab.index !== null &&
        picked.kind === 'curve'
      ) {
        grab.preview = [
          pulledHandle(
            picked,
            grab.index,
            grab.handle,
            toPlane(at),
            event.altKey
          ),
        ];
        canvas.style.cursor = 'grabbing';
        redraw();
        return;
      }
      if (grab.bend && picked.kind === 'curve') {
        grab.preview = [bent(picked, grab.bend, toPlane(at))];
        canvas.style.cursor = 'grabbing';
        redraw();
        return;
      }
      if (picked.kind === 'function') return;
      const [from, to] = [toPlane(grab.start), toPlane(at)];
      // A whole mark lands its first point (an ellipse its middle) on the grid, a polar
      // one's rings and spokes included, so one off it from before comes back. A label
      // goes where it's dragged, as it's placed where it's clicked (Epo 2026-11-13).
      const anchor =
        picked.kind === 'ellipse'
          ? ellipseCentre(picked.points)
          : pointsOf(picked)[0];
      if (grab.index === null) {
        const dragged: Vec = [
          anchor[0] + to[0] - from[0],
          anchor[1] + to[1] - from[1],
        ];
        const landed = picked.kind === 'label' ? dragged : snapPlane(dragged);
        const by: Vec = [landed[0] - anchor[0], landed[1] - anchor[1]];
        // One of several selected marks takes them all along.
        const group = selected.has(picked.id)
          ? model.marks.filter(({ id }) => selected.has(id))
          : [picked];
        grab.preview = group.map((mark) => moved(mark, null, by, false));
      } else
        grab.preview = [moved(picked, grab.index, snapped(at), event.shiftKey)];
      canvas.style.cursor = 'grabbing';
      redraw();
      return;
    }
    if (boxing && last && pressed) {
      boxing.to = at;
      redraw();
      return;
    }
    pointer = last || event.pointerType === 'mouse' ? at : null;
    hover = !last && event.pointerType === 'mouse' ? pickable(at) : null;
    near =
      !last && event.pointerType === 'mouse'
        ? (pointAt(at)?.id ?? markAt(at)?.id ?? null)
        : null;
    bendHover =
      !last && event.pointerType === 'mouse' && !knobAt(at)
        ? (bendAt(at)?.at ?? null)
        : null;
    canvas.style.cursor = hover || bendHover || knobAt(at) ? 'grab' : '';
    redraw();
  });
  canvas.addEventListener('pointerup', (event) => {
    const was = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    pinch = 0;
    if (panning) {
      panning = false;
      return;
    }
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
      trail.end();
      if (erased.size) write(model.marks.filter(({ id }) => !erased.has(id)));
    } else if (sized && was && pressed) {
      // Dragged, the size it was dragged to; a click, a grid step round.
      addCircle(sized.centre, sized.r ?? tickStep(view.ppu));
    } else if (held?.preview) {
      const { preview } = held;
      const next = model.marks.map(
        (mark) => preview.find(({ id }) => id === mark.id) ?? mark
      );
      if (JSON.stringify(next) !== JSON.stringify(model.marks)) write(next);
      if (tool === 'select' && !selected.has(held.id))
        selected = event.shiftKey
          ? new Set([...selected, held.id])
          : new Set([held.id]);
    } else if (boxed && pressed) {
      // A click on empty paper lets go; a box picks all it touches, Shift adding.
      const caught = model.marks
        .filter((mark) => touches(mark, boxed.from, boxed.to))
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
      const mark = held && model.marks.find(({ id }) => id === held.id);
      place(
        local(event),
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
      const mark = held && model.marks.find(({ id }) => id === held.id);
      editing =
        held && mark?.kind === 'curve' && held.index !== null
          ? { id: held.id, index: held.index }
          : null;
    }
    if (tool === 'select' && workspace) drawControls();
    pressed = false;
    if (event.pointerType !== 'mouse') pointer = null;
    redraw();
  });
  canvas.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    pressed = false;
    pinch = 0;
    grab = null;
    sizing = null;
    erasing = null;
    boxing = null;
    panning = false;
    trail.end();
    redraw();
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    hover = null;
    near = null;
    bendHover = null;
    redraw();
  });
  // A double click on a curve's point makes it a corner, or smooth again (K1).
  // With Select, a double click on a label edits it and on empty paper places one,
  // as on the canvas (Epo 2026-11-13).
  canvas.addEventListener('dblclick', (event) => {
    if (tool !== 'select') return;
    const px = local(event);
    const point = pointAt(px);
    const mark = point && model.marks.find(({ id }) => id === point.id);
    if (!point) {
      const under = markAt(px);
      if (!under || under.kind === 'label') {
        selected = new Set();
        editing = null;
        typeLabel(px);
        redraw();
      }
      return;
    }
    if (mark?.kind !== 'curve') return;
    const handles = handlesOf(mark).map(([a, b]): [Vec, Vec] => [a, b]);
    const loop = isLoop(mark.points);
    const at = mark.points[point.index];
    const [into, out] = pairOf(handles, point.index, loop);
    putPair(
      handles,
      point.index,
      loop,
      same(into, at) && same(out, at)
        ? pairOf(smoothHandles(mark.points), point.index, loop)
        : [at, at]
    );
    replaceOpen({ ...mark, handles });
    editing = { id: mark.id, index: point.index };
    redraw();
  });

  // Upright ellipses belong to x and y, not to rings and spokes.
  const tools = () =>
    TOOLS.filter(({ id }) => !(view.polar && id === 'ellipse'));
  const pick = (id: Tool) => {
    commitLabel();
    finish();
    hover = null;
    selected = new Set();
    editing = null;
    tool = id;
    drawControls();
  };

  // The objects list (Epo 2026-11-13, L2): a floating card of the plane's marks over
  // its top left, a sheet over its lower half on a phone. Workspace canvases only.
  const listOpen = () =>
    workspace && (listChoice ?? box().width >= SHEET_BELOW);
  const listLayout = () =>
    listOpen() ? (box().width < SHEET_BELOW ? 'sheet' : 'floating') : '';
  const toggleList = () => {
    listChoice = !listOpen();
    menuFor = null;
    drawControls();
  };
  /** What a row's typing makes of it: a function as it's typed, a point in the
   * empty row; anything else is an error under the row's icon. */
  const typedRow = (key: string, latex: string, ascii: string) => {
    // The empty row's mark keeps one id as it's typed, so its lit row stays put.
    const id = key === NEW_ROW ? (fresh?.id ?? newId()) : key;
    rowErrors.delete(key);
    drafts.delete(key);
    if (key === NEW_ROW) fresh = null;
    let row: ParsedRow | null = null;
    if (ascii.trim())
      try {
        row = parseRow(ascii);
      } catch (error) {
        if (!(error instanceof RowError)) throw error;
        rowErrors.set(key, error.message);
      }
    if (row?.kind === 'function' && markFunction(row.term)) {
      const mark: Mark = {
        id,
        kind: 'function',
        latex,
        term: row.term,
        ...(row.domain && { domain: row.domain }),
      };
      if (key === NEW_ROW) fresh = mark;
      else drafts.set(key, mark);
    } else if (row?.kind === 'point' && key === NEW_ROW)
      fresh = { at: row.coords, id, kind: 'dot' };
    else if (row && !rowErrors.has(key))
      rowErrors.set(
        key,
        row.kind === 'function'
          ? m.question_ui_graph_row_unreadable()
          : m.question_ui_graph_row_not_yet()
      );
    drawControls();
    redraw();
  };
  /** Writes what a function row holds: the empty row adds its mark and empties, an
   * emptied row removes its mark. A row that can't be read keeps its text and error;
   * leaving it (`left`) puts a saved row back as it was. */
  const commitRow = (key: string, left = false) => {
    const field = fields.get(key);
    if (key === NEW_ROW) {
      if (!fresh) return;
      if (model.marks.length >= MARKS_MAX) {
        rowErrors.set(key, m.drawing_board_plane_full());
        drawControls();
        return;
      }
      const mark = fresh;
      fresh = null;
      field?.setValue('', { silenceNotifications: true });
      add(mark);
    } else {
      if (!model.marks.some(({ id }) => id === key)) return;
      const draft = drafts.get(key);
      if (field && !field.value.trim())
        write(model.marks.filter(({ id }) => id !== key));
      else if (draft) replaceOpen(draft);
      else if (!left) return;
      drafts.delete(key);
      rowErrors.delete(key);
    }
    drawControls();
    redraw();
  };
  /** A row as it was before typing (Escape). */
  const discardRow = (key: string) => {
    drafts.delete(key);
    rowErrors.delete(key);
    if (key === NEW_ROW) {
      fresh = null;
      fields.get(key)?.setValue('', { silenceNotifications: true });
    }
    const mark = model.marks.find(({ id }) => id === key);
    const field = fields.get(key);
    if (mark?.kind === 'function')
      field?.setValue(mark.latex, { silenceNotifications: true });
    const input = controls.querySelector<HTMLInputElement>(
      `[data-row="${key}"] input`
    );
    if (mark && input) input.value = rowText(mark);
    drawControls();
    redraw();
  };
  /** A function row's typeset field, made once per row and kept across draws. */
  const fieldFor = (key: string) => {
    const known = fields.get(key);
    if (known || !Mathfield) return known ?? null;
    const field = new Mathfield();
    field.defaultMode = 'math';
    field.smartFence = true;
    field.mathVirtualKeyboardPolicy = 'auto';
    field.className = 'capy-plane-math';
    field.addEventListener('input', () =>
      typedRow(key, field.value, field.getValue('ascii-math'))
    );
    // Capture: MathLive takes keys inside its shadow root first.
    field.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        commitRow(key);
      },
      true
    );
    field.addEventListener('focusout', () => commitRow(key, true));
    fields.set(key, field);
    return field;
  };
  /** Loads MathLive the first time the list opens, then draws the rows. */
  const loadMathfield = async () => {
    const { MathfieldElement } = await import('mathlive');
    MathfieldElement.fontsDirectory = '/mathlive/fonts';
    MathfieldElement.soundsDirectory = null;
    MathfieldElement.locale = getLocale();
    Mathfield = MathfieldElement;
    drawControls();
  };
  /** Fields join the page before MathLive's shadow root takes styles and a value;
   * an unfocused row follows its mark, so undo shows in it. */
  const syncFields = () => {
    for (const [key, field] of fields) {
      const mark = model.marks.find(({ id }) => id === key);
      if (key !== NEW_ROW && mark?.kind !== 'function') {
        fields.delete(key);
        continue;
      }
      if (!field.isConnected) continue;
      if (!field.dataset.ready) {
        field.dataset.ready = '1';
        const styles = document.createElement('style');
        styles.textContent = mathFieldStyles;
        field.shadowRoot?.append(styles);
        field.menuItems = [];
      }
      if (
        mark?.kind === 'function' &&
        !drafts.has(key) &&
        field.value !== mark.latex &&
        document.activeElement !== field
      )
        field.setValue(mark.latex, { silenceNotifications: true });
    }
    if (focusRow) {
      controls
        .querySelector<HTMLInputElement>(`[data-row="${focusRow}"] input`)
        ?.select();
      focusRow = null;
    }
  };
  /** A point's, line's or label's row, typed in place and written on change. */
  const commitText = (mark: Mark, input: HTMLInputElement) => {
    const text = input.value.trim();
    const pairs = typedPairs(text);
    const changed: Mark | null =
      mark.kind === 'label'
        ? text
          ? { ...mark, text: text.slice(0, LABEL_LENGTH_MAX) }
          : null
        : mark.kind === 'dot' && pairs.length === 1
          ? { ...mark, at: pairs[0] }
          : (mark.kind === 'line' || mark.kind === 'vector') &&
              pairs.length === 2
            ? { ...mark, points: pairs }
            : mark;
    if (!changed) write(model.marks.filter(({ id }) => id !== mark.id));
    else if (changed === mark) input.value = rowText(mark);
    else replaceOpen(changed);
    redraw();
  };
  const rowText = (mark: Mark) =>
    mark.kind === 'dot'
      ? pairText(mark.at)
      : mark.kind === 'line' || mark.kind === 'vector'
        ? m.drawing_board_plane_from_to({
            from: pairText(mark.points[0]),
            to: pairText(mark.points[1]),
          })
        : mark.kind === 'label'
          ? mark.text
          : '';
  const addLabel = () => {
    const { height, width } = box();
    // Over a phone's sheet, the middle of what's left above it.
    const at = snapped([
      width / 2,
      listLayout() === 'sheet' ? height * 0.26 : height / 2,
    ]);
    const label: Mark = {
      at,
      id: newId(),
      kind: 'label',
      text: m.drawing_board_plane_label(),
    };
    focusRow = label.id;
    add(label);
    drawControls();
    redraw();
  };
  const lightRow = (id: string | null) => {
    if (hot === id) return;
    hot = id;
    redraw();
  };
  const rowBody = (mark: Mark, number: number) => {
    if (mark.kind === 'function') {
      const field = fieldFor(mark.id);
      field?.setAttribute(
        'aria-label',
        m.question_ui_graph_expression({ number })
      );
      return field;
    }
    if (
      mark.kind === 'dot' ||
      mark.kind === 'line' ||
      mark.kind === 'vector' ||
      mark.kind === 'label'
    )
      return html`<input
        aria-label=${mark.kind === 'label' ? m.drawing_board_plane_label() : m.question_ui_graph_expression({ number })}
        maxlength=${mark.kind === 'label' ? LABEL_LENGTH_MAX : 80}
        type="text"
        .value=${rowText(mark)}
        @change=${(event: Event) => commitText(mark, event.target as HTMLInputElement)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />`;
    // Shaped on the plane, not typed: the row names it (Epo 2026-11-13).
    const name =
      mark.kind === 'curve'
        ? m.chrome_curve()
        : mark.kind === 'ellipse'
          ? m.drawing_board_ellipse()
          : m.drawing_board_plane_formula();
    return html`<span class="capy-plane-row-text">${name}</span>`;
  };
  const objectsList = () => {
    const layout = listLayout();
    const rows = [...model.marks.map((mark) => drafts.get(mark.id) ?? mark)];
    const newField = fieldFor(NEW_ROW);
    newField?.setAttribute(
      'aria-label',
      m.question_ui_graph_expression({ number: rows.length + 1 })
    );
    const kindIcon = (key: string, icon: string | null) => {
      const error = rowErrors.get(key);
      return error
        ? html`<span class="err" title=${error}>${hugeIcon(AlertCircleIcon)}</span>`
        : icon && unsafeSVG(mathsIcon(icon));
    };
    return html`<div
      class="capy-plane-list"
      data-layout=${layout}
      @pointerleave=${() => {
        if (!controls.querySelector('.capy-plane-list :focus')) lightRow(null);
      }}
    >
      <ol
        @scroll=${() => {
          if (!menuFor) return;
          menuFor = null;
          drawControls();
        }}
      >
        ${repeat(
          rows,
          ({ id }) => id,
          (mark, index) => html`<li
            class=${selected.has(mark.id) ? 'on' : ''}
            data-row=${mark.id}
            @focusin=${() => lightRow(mark.id)}
            @pointerenter=${() => lightRow(mark.id)}
          >
            <span class="kind">${kindIcon(mark.id, ROW_ICON[mark.kind])}</span>
            ${rowBody(mark, index + 1)}
            <button
              aria-label=${m.a11y_more_actions()}
              class="more"
              type="button"
              @click=${(event: MouseEvent) => {
                const list = controls.querySelector('.capy-plane-list');
                const button = event.currentTarget as HTMLElement;
                menuFor =
                  menuFor?.id === mark.id || !list
                    ? null
                    : {
                        id: mark.id,
                        top:
                          button.getBoundingClientRect().bottom -
                          list.getBoundingClientRect().top +
                          4,
                      };
                drawControls();
              }}
            >
              ${hugeIcon(MoreVerticalIcon)}
            </button>
          </li>`
        )}
        <li data-row=${NEW_ROW} @focusin=${() => lightRow(fresh?.id ?? null)}>
          <span class="kind">${kindIcon(NEW_ROW, null)}</span>
          ${newField}
          <span></span>
        </li>
      </ol>
      <button class="add" type="button" @click=${addLabel}>
        ${hugeIcon(PlusSignIcon)} ${m.drawing_board_plane_label()}
      </button>
      ${
        menuFor
          ? html`<div class="capy-menu-list" role="menu" style="top:${menuFor.top}px">
              <button
                role="menuitem"
                type="button"
                @click=${() => {
                  const id = menuFor?.id;
                  menuFor = null;
                  hot = null;
                  selected.delete(id ?? '');
                  write(model.marks.filter((mark) => mark.id !== id));
                  drawControls();
                  redraw();
                }}
              >
                ${hugeIcon(Delete02Icon)} ${m.action_delete()}
              </button>
            </div>`
          : null
      }
    </div>`;
  };
  const drawControls = () => {
    root.dataset.tool = tool;
    const layout = listLayout();
    const showList = layout !== '';
    root.dataset.list = layout;
    if (showList && !Mathfield) void loadMathfield();
    const open = openMark();
    const finishLabel =
      open?.kind === 'curve'
        ? m.drawing_board_finish_curve()
        : open?.kind === 'line'
          ? m.drawing_board_finish_line()
          : null;
    render(
      html`${
        finishLabel
          ? html`<button
                class="capy-plane-finish"
                type="button"
                @click=${finish}
              >
                ${finishLabel}
              </button>`
          : null
      }
        ${
          typing
            ? html`<input
                aria-label=${m.drawing_board_chart_label()}
                class="capy-chart-label"
                maxlength=${LABEL_LENGTH_MAX}
                style="left:${(typing.at[0] - view.x0) * view.ppu}px;top:${(view.y0 - typing.at[1]) * view.ppu}px"
                type="text"
                .value=${typing.text}
                @blur=${commitLabel}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter') commitLabel();
                }}
              />
              <div
                class="capy-symbols capy-plane-symbols"
                style="top:${(view.y0 - typing.at[1]) * view.ppu + 20}px"
              >
                ${symbolButtons(insertSymbol)}
              </div>`
            : null
        }
        ${
          workspace
            ? html`<button
                aria-label=${m.drawing_board_objects()}
                aria-pressed=${showList}
                class="capy-plane-list-toggle"
                type="button"
                @click=${toggleList}
              >
                ${hugeIcon(LeftToRightListBulletIcon)}
              </button>`
            : null
        }
        ${showList ? objectsList() : null}
        <div class="capy-plane-tools">
          <div class="capy-plane-row">
            ${tools().map(
              ({ icon, id, key, label }) =>
                html`<button
                  aria-label=${label()}
                  aria-pressed=${tool === id}
                  type="button"
                  @click=${() => pick(id)}
                >
                  ${unsafeSVG(mathsIcon(icon))} ${toolTip(label(), key)}
                </button>`
            )}
          </div>
        </div>`,
      controls
    );
    syncFields();
    // The symbol row sits under its label, kept inside the plane.
    const symbols = controls.querySelector<HTMLElement>('.capy-plane-symbols');
    if (symbols && typing) {
      const half = symbols.offsetWidth / 2;
      const x = (typing.at[0] - view.x0) * view.ppu;
      symbols.style.left = `${Math.min(Math.max(x, half + 8), box().width - half - 8)}px`;
    }
    if (showList)
      controls
        .querySelector('.capy-plane-list li.on')
        ?.scrollIntoView({ block: 'nearest' });
  };
  drawControls();
  // Past 640 px either way the list turns card or sheet.
  new ResizeObserver(() => {
    if (root.dataset.list !== listLayout()) drawControls();
    redraw();
  }).observe(root);
  draw();
}

setPlaneEditor(openPlaneEditor);
