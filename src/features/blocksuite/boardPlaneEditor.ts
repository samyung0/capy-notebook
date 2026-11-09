import { ThemeProvider } from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { html, render } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { axisNumber } from '@/features/questions/graph';
import { tickStep } from '@/features/questions/graphTicks';
import { m } from '@/i18n';
import {
  ellipseCentre,
  ellipseIn,
  LABEL_LENGTH_MAX,
  MARKS_MAX,
  type Mark,
  PAPER,
  pathOf,
  pointsOf,
  pullEllipse,
} from './boardData';
import { drawChip, openBoardEditor, toolTip } from './boardEditorShell';
import { openFormulaCard } from './boardFormula';
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
  setPlaneEditor,
  traceMark,
} from './boardPlane';
import { mathsIcon } from './boardTools';

type Tool =
  | 'move'
  | 'point'
  | 'line'
  | 'vector'
  | 'curve'
  | 'ellipse'
  | 'label'
  | 'formula'
  | 'erase';

const PIXELS_TO_ERASE = 12;
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
/** How far from the origin the view goes, in the plane's units. */
const VIEW_MAX = 1e9;

/** Whether a mark has become what it set out to be. Leaving keeps what has, and removes
 * what hasn't, as AFFiNE removes a connector it cancels. */
const whole = (mark: Mark) => !('points' in mark) || mark.points.length > 1;

/** With their keys, shown in their tooltips (Epo 2026-11-08). */
const TOOLS: { icon: string; id: Tool; key: string; label: () => string }[] = [
  { icon: 'move', id: 'move', key: 'V', label: m.drawing_board_move_plane },
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

/** How far a mark is from a point on the plane, in plane units. */
function distanceTo(mark: Mark, [x, y]: Vec) {
  if (!('points' in mark)) return Math.hypot(x - mark.at[0], y - mark.at[1]);
  const between = (a: Vec, b: Vec) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = dx * dx + dy * dy;
    const t = length
      ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length))
      : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  const points = pathOf(mark);
  return points.length > 1
    ? Math.min(...points.slice(1).map((p, i) => between(points[i], p)))
    : Math.hypot(x - points[0][0], y - points[0][1]);
}

/** A mark with one of its points at `to`, or (`index` null) all of it moved by `to`. */
function moved(
  mark: Mark,
  index: number | null,
  to: Vec,
  uniform: boolean
): Mark {
  if (index !== null) {
    if (mark.kind === 'ellipse')
      return { ...mark, points: pullEllipse(mark.points, index, to, uniform) };
    return 'points' in mark
      ? { ...mark, points: mark.points.map((p, i) => (i === index ? to : p)) }
      : { ...mark, at: to };
  }
  const by = (p: Vec): Vec => [tidy(p[0] + to[0]), tidy(p[1] + to[1])];
  return 'points' in mark
    ? { ...mark, points: mark.points.map(by) }
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
    fit: () => fitMarks(),
    onEscape: () => {
      if (typing) {
        typing = null;
        drawControls();
        return true;
      }
      if (!openMark()) return false;
      finish();
      return true;
    },
    onLeave: () => {
      commitLabel();
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
  let tool: Tool = 'move';
  /** Where the pointer is, in pixels on this canvas, while it means something. */
  let pointer: Vec | null = null;
  /** Under the mouse: a point to pick up (with any tool but Erase), or with Move a
   * whole mark (`index` null). Nothing stays selected (Epo 2026-11-08, C). */
  let hover: { id: string; index: number | null } | null = null;
  /** The line, curve or ellipse under the mouse, whose points show (Epo 2026-11-08). */
  let near: string | null = null;
  /** The press on a mark: a tap does the tool's job, a drag moves it. Until it lifts the
   * moved copy is only drawn, so the drag is one undo step. */
  /** A new circle being sized: pressed at its middle, its radius from the drag. */
  let sizing: { centre: Vec; r: number | null; start: Vec } | null = null;
  let grab: {
    id: string;
    index: number | null;
    preview: Mark | null;
    start: Vec;
  } | null = null;

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
    return model.marks.find((mark) =>
      mark.kind === 'formula'
        ? onFormula(mark, px)
        : mark.kind !== 'dot' &&
          distanceTo(mark, here) <=
            (mark.kind === 'label' ? PIXELS_TO_LABEL : PIXELS_TO_ERASE) /
              view.ppu
    );
  };
  const pickable = (px: Vec) => {
    if (tool === 'erase') return null;
    const point = pointAt(px);
    if (point) return point;
    const mark = tool === 'move' ? markAt(px) : undefined;
    return mark ? { id: mark.id, index: null } : null;
  };
  /** To grid points; on a polar plane, to where a ring crosses a spoke. */
  const snapped = (px: Vec): Vec => {
    const [x, y] = toPlane(px);
    const step = minor();
    if (!view.polar) return [snapTo(x, step), snapTo(y, step)];
    const r = snapTo(Math.hypot(x, y), step);
    const spoke = (POLAR_SPOKE * Math.PI) / 180;
    const t = snapTo(Math.atan2(y, x), spoke);
    return [r * Math.cos(t), r * Math.sin(t)];
  };

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

  const draw = () => {
    const { height, width } = shell.sizeCanvas();
    const preview = grab?.preview;
    const marks = preview
      ? model.marks.map((mark) => (mark.id === preview.id ? preview : mark))
      : model.marks;
    drawPlane(
      ctx,
      { h: height, w: width, x: 0, y: 0 },
      view,
      marks,
      PAPER[theme.theme],
      // The open mark's points, and those of the mark under the pointer or held.
      new Set([openId, near, grab?.id].filter((id): id is string => !!id)),
      redraw
    );
    const picked = preview ? grab : hover;
    const mark = picked && marks.find(({ id }) => id === picked.id);
    if (picked && mark) drawPicked(mark, picked.index);
    if (preview && grab?.index != null) {
      const [x, y] = pointsOf(preview)[grab.index];
      const [sx, sy] = toScreen([x, y]);
      drawChip(
        ctx,
        `(${axisNumber(x, minor()) || 0}, ${axisNumber(y, minor()) || 0})`,
        sx,
        sy,
        width
      );
    }
    if (
      !pointer ||
      grab ||
      tool === 'move' ||
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
    tool = 'move';
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
    } else if (tool === 'label') {
      commitLabel();
      // Clicking near a label edits it; elsewhere a new one goes where it was clicked.
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
    } else if (tool === 'formula') {
      // A click on a formula opens it again; elsewhere a new one goes where it was
      // clicked. One formula, then back to Move.
      const near = model.marks.find(
        (mark): mark is Extract<Mark, { kind: 'formula' }> =>
          mark.kind === 'formula' && onFormula(mark, px)
      );
      const at = near?.at ?? toPlane(px);
      if (!near && model.marks.length >= MARKS_MAX) return;
      tool = 'move';
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
    } else if (tool === 'erase') {
      const here = toPlane(px);
      const reach = PIXELS_TO_ERASE / view.ppu;
      let nearest: Mark | null =
        model.marks.find(
          (mark) => mark.kind === 'formula' && onFormula(mark, px)
        ) ?? null;
      let best = nearest ? 0 : reach;
      for (const mark of model.marks) {
        const distance = distanceTo(mark, here);
        if (distance <= best) {
          best = distance;
          nearest = mark;
        }
      }
      if (nearest) write(model.marks.filter((mark) => mark !== nearest));
    }
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
    // One label, then back to Move, as the other tools do.
    if (tool === 'label') tool = 'move';
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
    view.ppu = Math.max(
      PPU_MIN,
      Math.min(
        PPU_MAX,
        (width - 100) / Math.max(x1 - x0, 1),
        (height - 160) / Math.max(y1 - y0, 1)
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
  const local = (event: PointerEvent): Vec => {
    const rect = box();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button) return;
    canvas.setPointerCapture(event.pointerId);
    const at = local(event);
    pointers.set(event.pointerId, at);
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
    const target = pickable(at);
    grab = target && { ...target, preview: null, start: at };
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
    if (last && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch)
        zoomAt(distance / pinch, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      panBy((at[0] - last[0]) / 2, (at[1] - last[1]) / 2);
      pinch = distance;
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
      const step = minor();
      const [from, to] = [toPlane(grab.start), toPlane(at)];
      // A whole mark lands its first point (an ellipse its middle) on the grid, so one
      // off it from before comes back.
      const anchor =
        picked.kind === 'ellipse'
          ? ellipseCentre(picked.points)
          : pointsOf(picked)[0];
      grab.preview = moved(
        picked,
        grab.index,
        grab.index === null
          ? [
              snapTo(anchor[0] + to[0] - from[0], step) - anchor[0],
              snapTo(anchor[1] + to[1] - from[1], step) - anchor[1],
            ]
          : snapped(at),
        event.shiftKey
      );
      canvas.style.cursor = 'grabbing';
      redraw();
      return;
    }
    if (last && pressed && tool === 'move') {
      panBy(at[0] - last[0], at[1] - last[1]);
      return;
    }
    pointer = last || event.pointerType === 'mouse' ? at : null;
    hover = !last && event.pointerType === 'mouse' ? pickable(at) : null;
    near =
      !last && event.pointerType === 'mouse'
        ? (pointAt(at)?.id ?? markAt(at)?.id ?? null)
        : null;
    canvas.style.cursor = hover ? 'grab' : '';
    redraw();
  });
  canvas.addEventListener('pointerup', (event) => {
    const was = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    pinch = 0;
    const held = grab;
    grab = null;
    canvas.style.cursor = '';
    const sized = sizing;
    sizing = null;
    if (sized && was && pressed) {
      // Dragged, the size it was dragged to; a click, a grid step round.
      addCircle(sized.centre, sized.r ?? tickStep(view.ppu));
    } else if (held?.preview) {
      const { preview } = held;
      const before = model.marks.find(({ id }) => id === preview.id);
      if (JSON.stringify(preview) !== JSON.stringify(before))
        write(
          model.marks.map((mark) => (mark.id === preview.id ? preview : mark))
        );
    } else if (was && pressed && tool !== 'move') {
      // A tap on a point does the tool's job right at it: Line starts from it.
      const mark = held && model.marks.find(({ id }) => id === held.id);
      place(
        local(event),
        mark && held?.index != null ? pointsOf(mark)[held.index] : undefined
      );
    }
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
    redraw();
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    hover = null;
    near = null;
    redraw();
  });

  // Upright ellipses belong to x and y, not to rings and spokes.
  const tools = () =>
    TOOLS.filter(({ id }) => !(view.polar && id === 'ellipse'));
  const pick = (id: Tool) => {
    commitLabel();
    finish();
    hover = null;
    tool = id;
    drawControls();
  };
  const drawControls = () => {
    root.dataset.tool = tool;
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
              />`
            : null
        }
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
  };
  drawControls();
  new ResizeObserver(redraw).observe(root);
  draw();
}

setPlaneEditor(openPlaneEditor);
