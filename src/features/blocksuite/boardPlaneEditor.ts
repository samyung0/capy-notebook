import {
  EditPropsStore,
  ThemeProvider,
} from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { html, render } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { axisNumber, tickStep } from '@/features/questions/graph';
import { m } from '@/i18n';
import {
  barBetween,
  clockAngle,
  minorStep,
  onCircle,
  smoothThrough,
  snapTo,
  type Vec,
} from './boardGeometry';
import {
  drawPlane,
  MARKS_MAX,
  type Mark,
  type PlaneElementModel,
  type PlaneView,
  setPlaneEditor,
} from './boardPlane';
import { fillRow, mathsIcon } from './boardTools';

type Tool = 'move' | 'point' | 'line' | 'curve' | 'bars' | 'pie' | 'erase';

const PIXELS_TO_FINISH = 16;
const PIXELS_TO_ERASE = 12;
const PPU_MIN = 1e-6;
const PPU_MAX = 1e6;

const TOOLS: { icon: string; id: Tool; label: () => string }[] = [
  { icon: 'move', id: 'move', label: m.drawing_board_move_plane },
  { icon: 'point', id: 'point', label: m.drawing_board_point },
  { icon: 'line', id: 'line', label: m.drawing_board_line_through_points },
  { icon: 'curve', id: 'curve', label: m.drawing_board_curve },
  { icon: 'bars', id: 'bars', label: m.drawing_board_bars },
  { icon: 'pie', id: 'pie', label: m.drawing_board_pie },
  { icon: 'erase', id: 'erase', label: m.drawing_board_erase_mark },
];

/** How far a mark is from a point on the plane, in plane units. */
function distanceTo(mark: Mark, [x, y]: Vec) {
  const between = (a: Vec, b: Vec) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = dx * dx + dy * dy;
    const t = length
      ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length))
      : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  const along = (points: Vec[]) =>
    points.length > 1
      ? Math.min(...points.slice(1).map((p, i) => between(points[i], p)))
      : Math.hypot(x - points[0][0], y - points[0][1]);
  if (mark.kind === 'dot') return Math.hypot(x - mark.at[0], y - mark.at[1]);
  if (mark.kind === 'bar') {
    const low = Math.min(0, mark.h);
    const high = Math.max(0, mark.h);
    return x >= mark.x && x <= mark.x + mark.w && y >= low && y <= high
      ? 0
      : Number.POSITIVE_INFINITY;
  }
  if (mark.kind === 'pie')
    return mark.radius
      ? Math.abs(Math.hypot(x - mark.at[0], y - mark.at[1]) - mark.radius)
      : Math.hypot(x - mark.at[0], y - mark.at[1]);
  return along(
    mark.kind === 'curve' ? smoothThrough(mark.points) : mark.points
  );
}

/** The endless plane, filling the board for editing. Done and Escape leave. Everything
 * plotted is written at once, so undo steps through it click by click; the view is
 * written on leaving. */
function openPlaneEditor(gfx: GfxController, model: PlaneElementModel) {
  const board = gfx.std.host.closest('.capy-board');
  if (!board || board.querySelector('.capy-plane-editor')) return;
  gfx.selection.clear();

  const root = document.createElement('div');
  root.className = 'capy-plane-editor';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', m.drawing_board_maths());
  const controls = document.createElement('div');
  root.append(canvas, controls);
  board.append(root);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const box = () => root.getBoundingClientRect();
  const [, , cardW, cardH] = model.deserializedXYWH;
  const start = box();
  const centre: Vec = [
    model.x0 + cardW / 2 / model.ppu,
    model.y0 - cardH / 2 / model.ppu,
  ];
  const view: PlaneView = {
    ppu: model.ppu,
    x0: centre[0] - start.width / 2 / model.ppu,
    y0: centre[1] + start.height / 2 / model.ppu,
  };
  let tool: Tool = 'move';
  /** The line, curve or pie still taking clicks. Undo simply shortens it. */
  let openId: string | null = null;
  /** Where the pointer is, in pixels on this canvas, while it means something. */
  let pointer: Vec | null = null;
  let bar: Vec | null = null;
  const resolve = gfx.std.get(ThemeProvider);

  const toPlane = ([px, py]: Vec): Vec => [
    view.x0 + px / view.ppu,
    view.y0 - py / view.ppu,
  ];
  const minor = () => minorStep(tickStep(view.ppu));
  const snapped = (px: Vec): Vec => {
    const [x, y] = toPlane(px);
    const step = minor();
    return [snapTo(x, step), snapTo(y, step)];
  };
  const openMark = () => model.marks.find((mark) => mark.id === openId);

  const write = (marks: Mark[]) => {
    gfx.doc.captureSync();
    gfx.surface?.updateElement(model.id, { marks });
    gfx.doc.captureSync();
  };
  const add = (mark: Mark) => {
    if (model.marks.length < MARKS_MAX) write([...model.marks, mark]);
  };
  const replaceOpen = (mark: Mark) =>
    write(model.marks.map((old) => (old.id === mark.id ? mark : old)));

  const draw = () => {
    const { height, width } = box();
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * scale)) {
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawPlane(
      ctx,
      { h: height, w: width, x: 0, y: 0 },
      view,
      model.marks,
      (c) => resolve.getColorValue(c, 'transparent', true)
    );
    if (!pointer || tool === 'move' || tool === 'erase') return;
    const X = (x: number) => (x - view.x0) * view.ppu;
    const Y = (y: number) => (view.y0 - y) * view.ppu;
    ctx.strokeStyle = '#1e96eb';
    ctx.fillStyle = '#1e96eb';
    ctx.lineWidth = 2;
    let at = snapped(pointer);
    let chip = `(${axisNumber(at[0], minor()) || 0}, ${axisNumber(at[1], minor()) || 0})`;
    const open = openMark();
    if (tool === 'bars' && bar) {
      const shape = barBetween(bar, toPlane(pointer), minor(), minor() * 2);
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(
        X(shape.x),
        Y(Math.max(shape.h, 0)),
        shape.w * view.ppu,
        Math.abs(shape.h) * view.ppu
      );
      ctx.setLineDash([]);
      chip = axisNumber(shape.h, minor()) || '0';
      at = [shape.x + shape.w, shape.h];
    } else if (tool === 'pie' && open?.kind === 'pie') {
      const here = toPlane(pointer);
      if (open.radius) {
        const angle = clockAngle(open.at, here);
        at = onCircle(open.at, open.radius, angle);
        const last = open.spokes.at(-1) ?? 0;
        chip = `${(angle - last + 360) % 360}°`;
        ctx.beginPath();
        ctx.moveTo(X(open.at[0]), Y(open.at[1]));
        ctx.lineTo(X(at[0]), Y(at[1]));
        ctx.stroke();
      } else {
        const radius = Math.hypot(here[0] - open.at[0], here[1] - open.at[1]);
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(
          X(open.at[0]),
          Y(open.at[1]),
          radius * view.ppu,
          0,
          Math.PI * 2
        );
        ctx.stroke();
        ctx.setLineDash([]);
        at = here;
        chip = axisNumber(radius, minor()) || '0';
      }
    } else if (
      (open?.kind === 'line' || open?.kind === 'curve') &&
      open.points.length
    ) {
      const path =
        open.kind === 'curve'
          ? smoothThrough([...open.points, at])
          : [...open.points.slice(-1), at];
      ctx.beginPath();
      for (const [i, [x, y]] of path.entries())
        if (i) ctx.lineTo(X(x), Y(y));
        else ctx.moveTo(X(x), Y(y));
      ctx.stroke();
    }
    if (tool === 'point' || tool === 'line' || tool === 'curve') {
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
    }
    ctx.font = '13px Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(chip).width + 14;
    const chipX = Math.min(width - textWidth - 4, X(at[0]) + 10);
    const chipY = Math.max(4, Y(at[1]) - 30);
    ctx.fillStyle = '#111';
    ctx.fillRect(chipX, chipY, textWidth, 22);
    ctx.fillStyle = '#fff';
    ctx.fillText(chip, chipX + 7, chipY + 11);
  };
  let frame = 0;
  const redraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  const newId = () => crypto.randomUUID();
  /** A press lands where it lifts, so a finger can line it up against the chip. */
  const place = (px: Vec) => {
    const at = snapped(px);
    const open = openMark();
    if (tool === 'point') add({ at, id: newId(), kind: 'dot' });
    else if (tool === 'line' || tool === 'curve') {
      if (open?.kind === tool) {
        const last = open.points.at(-1);
        const nearLast =
          last &&
          Math.hypot(
            (last[0] - at[0]) * view.ppu,
            (last[1] - at[1]) * view.ppu
          ) < PIXELS_TO_FINISH;
        if (nearLast) {
          openId = null;
          return;
        }
        replaceOpen({ ...open, points: [...open.points, at] });
        if (tool === 'line') openId = null;
        return;
      }
      if (model.marks.length >= MARKS_MAX) return;
      openId = newId();
      add({ id: openId, kind: tool, points: [at] });
    } else if (tool === 'pie') {
      const here = toPlane(px);
      if (open?.kind !== 'pie') {
        if (model.marks.length >= MARKS_MAX) return;
        openId = newId();
        add({ at, id: openId, kind: 'pie', radius: 0, spokes: [] });
        return;
      }
      const pixels =
        Math.hypot(here[0] - open.at[0], here[1] - open.at[1]) * view.ppu;
      if (pixels < PIXELS_TO_FINISH) {
        openId = null;
        return;
      }
      if (open.radius)
        replaceOpen({
          ...open,
          spokes: [...open.spokes, clockAngle(open.at, here)],
        });
      else replaceOpen({ ...open, radius: pixels / view.ppu, spokes: [0] });
    } else if (tool === 'erase') {
      const here = toPlane(px);
      const reach = PIXELS_TO_ERASE / view.ppu;
      let nearest: Mark | null = null;
      let best = reach;
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

  const zoomAt = (factor: number, [px, py]: Vec) => {
    const [x, y] = toPlane([px, py]);
    view.ppu = Math.max(PPU_MIN, Math.min(PPU_MAX, view.ppu * factor));
    view.x0 = x - px / view.ppu;
    view.y0 = y + py / view.ppu;
    redraw();
  };
  const panBy = (dx: number, dy: number) => {
    view.x0 -= dx / view.ppu;
    view.y0 += dy / view.ppu;
    redraw();
  };
  const fit = () => {
    const seen: Vec[] = [[0, 0]];
    for (const mark of model.marks) {
      if (mark.kind === 'dot') seen.push(mark.at);
      else if (mark.kind === 'bar')
        seen.push([mark.x, mark.h], [mark.x + mark.w, 0]);
      else if (mark.kind === 'pie')
        seen.push(
          [mark.at[0] - mark.radius, mark.at[1] - mark.radius],
          [mark.at[0] + mark.radius, mark.at[1] + mark.radius]
        );
      else seen.push(...mark.points);
    }
    const xs = seen.map(([x]) => x);
    const ys = seen.map(([, y]) => y);
    const { height, width } = box();
    const [x0, x1, y0, y1] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
    ];
    view.ppu = Math.min(
      (width - 100) / Math.max(x1 - x0, 1),
      (height - 160) / Math.max(y1 - y0, 1)
    );
    view.x0 = (x0 + x1) / 2 - width / 2 / view.ppu;
    view.y0 = (y0 + y1) / 2 + height / 2 / view.ppu;
    redraw();
  };

  const close = () => {
    const { width, height } = box();
    const [x, y] = [
      view.x0 + width / 2 / view.ppu,
      view.y0 - height / 2 / view.ppu,
    ];
    const [, , w, h] = model.deserializedXYWH;
    // The view is where the student looks, not part of the undo history.
    if (gfx.getElementById(model.id))
      gfx.doc.withoutTransact(() => {
        model.ppu = view.ppu;
        model.x0 = x - w / 2 / view.ppu;
        model.y0 = y + h / 2 / view.ppu;
      });
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey, true);
    updates.unsubscribe();
    render(null, controls);
    root.remove();
    closing.delete(gfx);
    if (gfx.getElementById(model.id))
      gfx.selection.set({ editing: false, elements: [model.id] });
  };
  closing.set(gfx, close);

  // Escape does what Done does, and the board's own shortcuts stay out of the plane.
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
      event.preventDefault();
      if (event.shiftKey) gfx.doc.redo();
      else gfx.doc.undo();
    }
  };
  window.addEventListener('keydown', onKey, true);

  const updates = gfx.surface
    ? gfx.surface.elementUpdated.subscribe(() => {
        if (gfx.getElementById(model.id)) redraw();
        else close();
      })
    : { unsubscribe: () => undefined };

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
  let pressed: { moved: boolean; start: Vec } | null = null;
  const local = (event: PointerEvent): Vec => {
    const rect = box();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    const at = local(event);
    pointers.set(event.pointerId, at);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      pressed = null;
      bar = null;
      pointer = null;
      redraw();
      return;
    }
    pressed = { moved: false, start: at };
    pointer = at;
    if (tool === 'bars') bar = toPlane(at);
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
    if (last && pressed) {
      if (Math.hypot(at[0] - pressed.start[0], at[1] - pressed.start[1]) > 3)
        pressed.moved = true;
      if (tool === 'move') {
        panBy(at[0] - last[0], at[1] - last[1]);
        return;
      }
    }
    pointer = last || event.pointerType === 'mouse' ? at : null;
    redraw();
  });
  const lift = (event: PointerEvent) => {
    const was = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    pinch = 0;
    if (was && pressed) {
      const at = local(event);
      if (tool === 'bars' && bar && pressed.moved) {
        const shape = barBetween(bar, toPlane(at), minor(), minor() * 2);
        if (shape.h)
          add({
            ...shape,
            fill: gfx.std.get(EditPropsStore).lastProps$.value['shape:rect']
              .fillColor,
            id: newId(),
            kind: 'bar',
          });
      } else if (tool !== 'move' && tool !== 'bars') place(at);
    }
    pressed = null;
    bar = null;
    if (event.pointerType !== 'mouse') pointer = null;
    redraw();
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    pressed = null;
    bar = null;
    pinch = 0;
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    redraw();
  });

  const drawControls = () => {
    root.dataset.tool = tool;
    render(
      html`<div class="capy-plane-top">
          <button type="button" @click=${fit}>${m.drawing_board_fit()}</button>
          <button class="primary" type="button" @click=${close}>
            ${m.drawing_board_done()}
          </button>
        </div>
        <div class="capy-plane-zoom">
          <button
            aria-label=${m.drawing_board_zoom_out()}
            title=${m.drawing_board_zoom_out()}
            type="button"
            @click=${() => {
              const { height, width } = box();
              zoomAt(1 / 1.5, [width / 2, height / 2]);
            }}
          >
            −
          </button>
          <button
            aria-label=${m.drawing_board_zoom_in()}
            title=${m.drawing_board_zoom_in()}
            type="button"
            @click=${() => {
              const { height, width } = box();
              zoomAt(1.5, [width / 2, height / 2]);
            }}
          >
            +
          </button>
        </div>
        <div class="capy-plane-tools">
          ${tool === 'bars' ? fillRow(gfx, drawControls) : null}
          <div class="capy-plane-row">
            ${TOOLS.map(
              ({ icon, id, label }) =>
                html`<button
                  aria-label=${label()}
                  aria-pressed=${tool === id}
                  title=${label()}
                  type="button"
                  @click=${() => {
                    tool = id;
                    openId = null;
                    pointer = null;
                    drawControls();
                    redraw();
                  }}
                >
                  ${unsafeSVG(mathsIcon(icon))}
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

const closing = new WeakMap<GfxController, () => void>();

/** Leaves the plane if it's open, as saving or making the image does. */
export function closePlaneEditor(gfx: GfxController) {
  closing.get(gfx)?.();
}

setPlaneEditor(openPlaneEditor);
