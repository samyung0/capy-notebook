import {
  EditPropsStore,
  ThemeProvider,
} from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { html, nothing, render } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { m } from '@/i18n';
import {
  type ChartElementModel,
  drawChart,
  LABEL_REACH,
  setChartEditor,
} from './boardChart';
import {
  AXIS_MAX,
  BAR_SHARE,
  BARS_MAX,
  barPlot,
  type ChartBar,
  LABEL_LENGTH_MAX,
  LABELS_MAX,
  PAPER,
  type Pads,
  type PieLabel,
  pieCircle,
  SPOKES_MAX,
} from './boardData';
import { drawChip, openBoardEditor, toolTip } from './boardEditorShell';
import { alongDrag, ERASER_SIZE, EraserTrail } from './boardEraser';
import { clockAngle, snapTo, type Vec } from './boardGeometry';
import { fillRow, mathsIcon } from './boardTools';

type Tool = 'select' | 'draw' | 'fill' | 'label' | 'erase';
/** What Select picked (Epo 2026-11-09): a bar, a pie's line or a pie's label. */
type Picked =
  | { id: string; kind: 'bar' }
  | { angle: number; kind: 'spoke' }
  | { id: string; kind: 'label' };

const PIXELS_TO_LABEL = 30;
/** How far a press goes before it's a drag rather than a click. */
const PIXELS_TO_DRAG = 4;
const BLUE = '#1e96eb';
const HALO = 'rgba(30, 150, 235, 0.18)';
/** Most numbered lines the axis takes. */
const AXIS_LINES_MAX = 100;
/** The smallest axis top zooming in reaches. */
const AXIS_MIN = 1e-3;
/** A zoom is written, one undo step, once it has rested this long. */
const ZOOM_SETTLE_MS = 300;
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** An axis to a top, about five numbered lines in 1, 2, 2.5 or 5 steps. */
function niceAxis(top: number) {
  const rough = top / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const axisStep =
    (NICE_STEPS.find((step) => step * power >= rough) ?? 10) * power;
  return {
    axisMax: Number(
      (Math.ceil(top / axisStep - 1e-9) * axisStep).toPrecision(12)
    ),
    axisStep: Number(axisStep.toPrecision(12)),
  };
}

/** A bar or pie chart, filling the board for editing. Each change is written at once,
 * one undo step. */
function openChartEditor(gfx: GfxController, model: ChartElementModel) {
  let frame = 0;
  let tool: Tool = 'draw';
  /** The label being typed: under a bar, or in a pie at an angle. */
  let typing: {
    angle?: number;
    barId?: string;
    id?: string;
    text: string;
    x: number;
    y: number;
  } | null = null;
  /** The bar being dragged up. */
  let live: { slot: number; value: number } | null = null;
  /** What a press with Select landed on, which a drag moves. */
  let picked: Picked | null = null;
  /** What's selected, as on the board: a click, Shift adding or taking away, or a box
   * on empty paper; Delete removes them all (Epo 2026-11-09). */
  let chosen: Picked[] = [];
  let boxing: { adding: boolean; from: Vec; to: Vec } | null = null;
  const same = (a: Picked, b: Picked) =>
    a.kind === b.kind &&
    (a.kind === 'spoke'
      ? a.angle === (b as typeof a).angle
      : a.id === (b as typeof a).id);
  /** A pie's line or label being dragged round, to this angle; written when it lifts. */
  let turning: { angle: number; moved: boolean } | null = null;
  /** What the eraser has passed over while pressed; gone in one step when it lifts. */
  let erasing: {
    bars: Set<string>;
    labels: Set<string>;
    spokes: Set<number>;
  } | null = null;
  const trail = new EraserTrail(() => redraw());
  /** The value axis while a zoom is still moving (Epo 2026-11-08), and its top
   * before rounding. */
  let zoom: { axisMax: number; axisStep: number; top: number } | null = null;
  let zoomTimer: ReturnType<typeof setTimeout> | undefined;
  let pointer: Vec | null = null;

  const shell = openBoardEditor(gfx, model.id, {
    fit: model.kind === 'bar' ? () => fitAxis() : undefined,
    onDelete: () => {
      if (!chosen.length) return false;
      remove(chosen);
      chosen = [];
      picked = null;
      redraw();
      return true;
    },
    onEscape: () => {
      if (typing) {
        typing = null;
        drawControls();
        return true;
      }
      if (!chosen.length) return false;
      chosen = [];
      redraw();
      return true;
    },
    onLeave: () => {
      commitLabel();
      settleZoom();
      cancelAnimationFrame(frame);
    },
    onShortcut: (key) => {
      const found = tools.find((each) => each.key === key);
      if (found) pick(found.id);
      return !!found;
    },
    onUpdate: () => {
      drawControls();
      redraw();
    },
    // A bar chart zooms its value axis: in lowers the top.
    zoom:
      model.kind === 'bar'
        ? { in: () => zoomBy(1 / 1.5), out: () => zoomBy(1.5) }
        : undefined,
  });
  if (!shell) return;
  const { box, canvas, controls, ctx, root } = shell;
  root.classList.add('capy-chart-editor');
  const resolve = gfx.std.get(ThemeProvider);
  const isBar = model.kind === 'bar';

  const update = (props: Partial<ChartElementModel>) =>
    shell.write(() => gfx.surface?.updateElement(model.id, props));

  const pads = (): Pads => {
    const phone = box().width < 768;
    return isBar
      ? {
          // The tools with their fill row, and the labels under the bars.
          bottom: 128,
          left: phone ? 44 : 70,
          right: phone ? 16 : 40,
          top: phone ? 112 : 64,
        }
      : { bottom: 92, left: 16, right: 16, top: 64 };
  };
  const slots = () =>
    Math.max(
      3,
      model.bars.length < BARS_MAX ? model.bars.length + 1 : BARS_MAX
    );
  const screen = () => {
    const { height, width } = box();
    return { h: height, w: width, x: 0, y: 0 };
  };
  const local = (event: PointerEvent): Vec => {
    const rect = box();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const slotAt = ([x]: Vec) => {
    const { left, slotW } = barPlot(screen(), pads(), slots());
    return Math.max(0, Math.min(slots() - 1, Math.floor((x - left) / slotW)));
  };
  /** A bar's height from the pointer's, in half steps up to the axis's end. */
  const valueAt = ([, y]: Vec) => {
    const { base, height } = barPlot(screen(), pads(), slots());
    const { axisMax, axisStep } = axis();
    const value = ((base - y) / height) * axisMax;
    return Math.max(0, Math.min(axisMax, snapTo(value, axisStep / 2)));
  };
  const angleAt = ([x, y]: Vec) => {
    const { cx, cy } = pieCircle(screen(), pads());
    return clockAngle([cx, -cy], [x, -y]);
  };
  /** The line before an angle, clockwise: where its slice starts. */
  const lineBefore = (angle: number) =>
    [...model.spokes]
      .sort((a, b) => a - b)
      .filter((spoke) => spoke <= angle)
      .at(-1) ?? Math.max(...model.spokes, 0);
  /** The sector a new line closes: from the line before it, clockwise. */
  const sectorTo = (angle: number) => (angle - lineBefore(angle) + 360) % 360;
  /** The pie label under a point, if any. */
  const labelAt = ([x, y]: Vec) => {
    const { cx, cy, r } = pieCircle(screen(), pads());
    return model.labels.find(({ angle }) => {
      const turn = (angle * Math.PI) / 180;
      return (
        Math.hypot(
          x - (cx + r * LABEL_REACH * Math.sin(turn)),
          y - (cy - r * LABEL_REACH * Math.cos(turn))
        ) < PIXELS_TO_LABEL
      );
    });
  };

  /** A bar's box on screen, its label under it included. */
  const barBox = (slot: number, value: number) => {
    const { base, height, left, slotW } = barPlot(screen(), pads(), slots());
    const w = slotW * BAR_SHARE;
    const top =
      base - (height * Math.min(value, axis().axisMax)) / axis().axisMax;
    return {
      bottom: base + 24,
      left: left + slotW * slot + (slotW - w) / 2,
      top,
      w,
    };
  };
  /** How far a pixel is from a pie's line, rim to centre. */
  const offSpoke = ([x, y]: Vec, spoke: number) => {
    const { cx, cy, r } = pieCircle(screen(), pads());
    const turn = (spoke * Math.PI) / 180;
    const [dx, dy] = [Math.sin(turn), -Math.cos(turn)];
    const t = Math.max(0, Math.min(r, (x - cx) * dx + (y - cy) * dy));
    return Math.hypot(x - cx - t * dx, y - cy - t * dy);
  };
  /** The bar, pie line or pie label under a pixel, within `reach` of it. */
  const hitAt = (at: Vec, reach: number): Picked | null => {
    if (isBar) {
      const slot = model.bars.findIndex(({ value }, i) => {
        const bar = barBox(i, value);
        return (
          at[0] >= bar.left - reach &&
          at[0] <= bar.left + bar.w + reach &&
          at[1] >= bar.top - reach &&
          at[1] <= bar.bottom
        );
      });
      const bar = model.bars[slot];
      return bar ? { id: bar.id, kind: 'bar' } : null;
    }
    const label = labelAt(at);
    if (label) return { id: label.id, kind: 'label' };
    const spoke = model.spokes.find((each) => offSpoke(at, each) <= reach);
    return spoke === undefined ? null : { angle: spoke, kind: 'spoke' };
  };
  /** Removes them in one step. */
  const remove = (gone: Picked[]) => {
    const has = (item: Picked) => gone.some((other) => same(other, item));
    const spokeGone = (angle: number) => has({ angle, kind: 'spoke' });
    update({
      bars: model.bars.filter(({ id }) => !has({ id, kind: 'bar' })),
      fills: (model.fills ?? []).filter(({ from }) => !spokeGone(from)),
      labels: model.labels.filter(({ id }) => !has({ id, kind: 'label' })),
      spokes: model.spokes.filter((spoke) => !spokeGone(spoke)),
    });
  };
  /** Everything with a part inside a box of pixels, as the board's selection box. */
  const boxed = ([ax, ay]: Vec, [bx, by]: Vec): Picked[] => {
    const [x0, x1, y0, y1] = [
      Math.min(ax, bx),
      Math.max(ax, bx),
      Math.min(ay, by),
      Math.max(ay, by),
    ];
    const inside = ([x, y]: Vec) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    if (isBar)
      return model.bars
        .filter(({ value }, i) => {
          const bar = barBox(i, value);
          return (
            bar.left <= x1 &&
            bar.left + bar.w >= x0 &&
            bar.top <= y1 &&
            bar.bottom >= y0
          );
        })
        .map(({ id }) => ({ id, kind: 'bar' }));
    const { cx, cy, r } = pieCircle(screen(), pads());
    const at = (angle: number, reach: number): Vec => {
      const turn = (angle * Math.PI) / 180;
      return [cx + reach * Math.sin(turn), cy - reach * Math.cos(turn)];
    };
    // A line is in when a point along it is, sampled finer than any box worth drawing.
    const spokes: Picked[] = model.spokes
      .filter((spoke) =>
        Array.from({ length: 41 }, (_, i) => at(spoke, (r * i) / 40)).some(
          inside
        )
      )
      .map((angle) => ({ angle, kind: 'spoke' }));
    const labels: Picked[] = model.labels
      .filter(({ angle }) => inside(at(angle, r * LABEL_REACH)))
      .map(({ id }) => ({ id, kind: 'label' }));
    return [...spokes, ...labels];
  };
  /** Whatever is within the eraser's reach of a pixel joins what it's erasing. */
  const eraseNear = (at: Vec) => {
    const hit = hitAt(at, ERASER_SIZE / 2);
    if (hit?.kind === 'bar') erasing?.bars.add(hit.id);
    if (hit?.kind === 'label') erasing?.labels.add(hit.id);
    if (hit?.kind === 'spoke') erasing?.spokes.add(hit.angle);
  };

  /** A selected or held item, in blue, where it's being dragged to. */
  const drawPicked = (
    one: Picked,
    area: { h: number; w: number; x: number; y: number },
    bars: ChartBar[],
    labels: PieLabel[],
    spokes: number[]
  ) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const outline = (trace: () => void) => {
      for (const [colour, width] of [
        [HALO, 10],
        [BLUE, 2],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        ctx.beginPath();
        trace();
        ctx.stroke();
      }
    };
    if (one.kind === 'bar') {
      const { id } = one;
      const slot = bars.findIndex((bar) => bar.id === id);
      if (slot < 0) return;
      const bar = barBox(slot, bars[slot].value);
      outline(() =>
        ctx.rect(bar.left, bar.top, bar.w, bar.bottom - 24 - bar.top)
      );
      return;
    }
    const { cx, cy, r } = pieCircle(area, pads());
    const at = (angle: number, reach: number): Vec => {
      const turn = (angle * Math.PI) / 180;
      return [cx + reach * Math.sin(turn), cy - reach * Math.cos(turn)];
    };
    if (one.kind === 'spoke') {
      const held = picked && same(picked, one);
      const angle = held && turning ? turning.angle : one.angle;
      if (!spokes.includes(angle)) return;
      const [x, y] = at(angle, r);
      outline(() => {
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
      });
      ctx.fillStyle = BLUE;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (held && turning?.moved) drawChip(ctx, `${angle}°`, x, y, area.w);
      return;
    }
    if (one.kind === 'label') {
      const { id } = one;
      const label = labels.find((each) => each.id === id);
      if (!label) return;
      const [x, y] = at(label.angle, r * LABEL_REACH);
      ctx.font = '12px Arial, sans-serif';
      const w = ctx.measureText(label.text).width + 12;
      ctx.fillStyle = HALO;
      ctx.fillRect(x - w / 2, y - 11, w, 22);
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - w / 2, y - 11, w, 22);
    }
  };

  const draw = () => {
    const { height, width } = shell.sizeCanvas();
    const area = { h: height, w: width, x: 0, y: 0 };
    let bars: ChartBar[] = model.bars;
    if (live) {
      const { slot, value } = live;
      bars = bars.map((bar, i) => (i === slot ? { ...bar, value } : bar));
      if (slot >= bars.length)
        bars = [...bars, { fill: newFill(), id: '', label: '', value }];
    }
    let { fills, labels, spokes } = model;
    if (turning && picked?.kind === 'spoke') {
      const { angle: from } = picked;
      const { angle: to } = turning;
      spokes = spokes.map((spoke) => (spoke === from ? to : spoke));
      fills = fills?.map((slice) =>
        slice.from === from ? { ...slice, from: to } : slice
      );
    }
    if (turning && picked?.kind === 'label') {
      const { id } = picked;
      const { angle } = turning;
      labels = labels.map((label) =>
        label.id === id ? { ...label, angle } : label
      );
    }
    if (erasing) {
      const gone = erasing;
      bars = bars.filter(({ id }) => !gone.bars.has(id));
      labels = labels.filter(({ id }) => !gone.labels.has(id));
      spokes = spokes.filter((spoke) => !gone.spokes.has(spoke));
      fills = fills?.filter((slice) => !gone.spokes.has(slice.from));
    }
    const { kind } = model;
    const { axisMax, axisStep } = axis();
    drawChart(
      ctx,
      area,
      { axisMax, axisStep, bars, fills, kind, labels, spokes },
      (color) => resolve.getColorValue(color, 'transparent', true),
      PAPER[resolve.theme],
      pads(),
      isBar ? slots() : undefined
    );
    if (live) {
      const {
        base,
        height: plot,
        left,
        slotW,
      } = barPlot(area, pads(), slots());
      drawChip(
        ctx,
        `${Number(live.value.toPrecision(10))}`,
        left + slotW * live.slot + slotW * 0.78,
        base - (plot * live.value) / axisMax + 20,
        width
      );
    }
    for (const one of chosen) drawPicked(one, area, bars, labels, spokes);
    if (picked && turning && !chosen.some((one) => picked && same(one, picked)))
      drawPicked(picked, area, bars, labels, spokes);
    if (
      live &&
      picked?.kind === 'bar' &&
      !chosen.some((one) => picked && same(one, picked))
    )
      drawPicked(picked, area, bars, labels, spokes);
    trail.draw(ctx);
    if (boxing) {
      const { from, to } = boxing;
      ctx.fillStyle = 'rgba(30, 150, 235, 0.08)';
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1;
      ctx.fillRect(from[0], from[1], to[0] - from[0], to[1] - from[1]);
      ctx.strokeRect(from[0], from[1], to[0] - from[0], to[1] - from[1]);
    }
    // Where a press would set a bar, as the plane shows where a point would go.
    if (isBar && tool === 'draw' && pointer && !live) {
      const slot = slotAt(pointer);
      if (slot <= model.bars.length && slot < BARS_MAX) {
        const value = valueAt(pointer);
        const {
          base,
          height: plot,
          left,
          slotW,
        } = barPlot(area, pads(), slots());
        const y = base - (plot * value) / axisMax;
        const w = slotW * BAR_SHARE;
        const x = left + slotW * slot + (slotW - w) / 2;
        ctx.strokeStyle = '#1e96eb';
        ctx.fillStyle = '#1e96eb';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x + w / 2, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        drawChip(ctx, `${Number(value.toPrecision(10))}`, x + w / 2, y, width);
      }
    }
    if (!isBar && tool === 'draw' && pointer) {
      const { cx, cy, r } = pieCircle(area, pads());
      const angle = angleAt(pointer);
      const turn = (angle * Math.PI) / 180;
      const [x, y] = [cx + r * Math.sin(turn), cy - r * Math.cos(turn)];
      ctx.strokeStyle = '#1e96eb';
      ctx.fillStyle = '#1e96eb';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      drawChip(ctx, `${sectorTo(angle)}°`, x, y, width);
    }
  };
  const redraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  const newFill = () =>
    gfx.std.get(EditPropsStore).lastProps$.value['shape:rect'].fillColor;

  const openLabel = (at: Vec) => {
    if (isBar) {
      const slot = slotAt(at);
      const bar = model.bars[slot];
      if (!bar) return;
      const { base, left, slotW } = barPlot(screen(), pads(), slots());
      typing = {
        barId: bar.id,
        text: bar.label,
        x: left + slotW * (slot + 0.5),
        y: base + 14,
      };
    } else {
      const label = labelAt(at);
      if (!label && model.labels.length >= LABELS_MAX) return;
      const angle = label?.angle ?? angleAt(at);
      const { cx, cy, r } = pieCircle(screen(), pads());
      const turn = (angle * Math.PI) / 180;
      typing = {
        angle,
        id: label?.id,
        text: label?.text ?? '',
        x: cx + r * LABEL_REACH * Math.sin(turn),
        y: cy - r * LABEL_REACH * Math.cos(turn),
      };
    }
    drawControls();
    controls.querySelector<HTMLInputElement>('.capy-chart-label')?.select();
  };
  const commitLabel = () => {
    const field = controls.querySelector<HTMLInputElement>('.capy-chart-label');
    const open = typing;
    typing = null;
    if (!open || !field) return;
    const text = field.value.trim();
    if (open.barId) {
      const bars = model.bars.map((bar) =>
        bar.id === open.barId ? { ...bar, label: text } : bar
      );
      if (text !== model.bars.find((bar) => bar.id === open.barId)?.label)
        update({ bars });
    } else {
      const others: PieLabel[] = model.labels.filter(
        ({ id }) => id !== open.id
      );
      if (text)
        update({
          labels: [
            ...others,
            {
              angle: open.angle ?? 0,
              id: open.id ?? crypto.randomUUID(),
              text,
            },
          ],
        });
      else if (open.id) update({ labels: others });
    }
    // One label, then back to Select, as on the plane.
    if (tool === 'label') tool = 'select';
    drawControls();
  };

  /** The pie slice under a point takes the picked fill; No fill clears it. */
  const fillAt = (at: Vec) => {
    if (!model.spokes.length) return;
    const from = lineBefore(angleAt(at));
    const fill = newFill();
    const others = (model.fills ?? []).filter(
      (slice) => slice.from !== from && model.spokes.includes(slice.from)
    );
    update({
      fills: fill === 'transparent' ? others : [...others, { fill, from }],
    });
  };

  const setAxis = (event: Event, which: 'axisMax' | 'axisStep') => {
    const field = event.target as HTMLInputElement;
    const value = Number(field.value);
    const axisMax = which === 'axisMax' ? value : model.axisMax;
    const axisStep = which === 'axisStep' ? value : model.axisStep;
    if (
      value > 0 &&
      axisMax <= AXIS_MAX &&
      axisStep <= axisMax &&
      axisMax / axisStep <= AXIS_LINES_MAX
    )
      update({ axisMax, axisStep });
    else field.value = String(model[which]);
  };
  /** The axis ends at the first numbered line above the tallest bar. */
  const fitAxis = () => {
    const tallest = Math.max(...model.bars.map(({ value }) => value), 0);
    const axisMax =
      Math.max(Math.ceil(tallest / model.axisStep), 1) * model.axisStep;
    if (axisMax !== model.axisMax) update({ axisMax });
  };

  const axis = () => zoom ?? model;
  const settleZoom = () => {
    clearTimeout(zoomTimer);
    const settled = zoom;
    zoom = null;
    if (
      settled &&
      (settled.axisMax !== model.axisMax || settled.axisStep !== model.axisStep)
    )
      update({ axisMax: settled.axisMax, axisStep: settled.axisStep });
  };
  /** Wheel and pinch change the axis's top, the step following; bars stay on 0. */
  const zoomBy = (factor: number) => {
    const top = Math.max(
      AXIS_MIN,
      Math.min(AXIS_MAX, (zoom?.top ?? model.axisMax) * factor)
    );
    zoom = { ...niceAxis(top), top };
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(settleZoom, ZOOM_SETTLE_MS);
    redraw();
  };
  if (isBar)
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        zoomBy(Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.002)));
      },
      { passive: false }
    );

  const touches = new Map<number, Vec>();
  let pinch = 0;
  let pressed = false;
  let pressedAt: Vec = [0, 0];
  /** Where the pointer was at its last move, so a swipe erases all along it. */
  let lastAt: Vec = [0, 0];
  /** Whether a press with Select has gone far enough to drag what it picked. */
  let dragging = false;
  canvas.addEventListener('pointerdown', (event) => {
    touches.set(event.pointerId, local(event));
    if (isBar && touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      pressed = false;
      live = null;
      pointer = null;
      redraw();
      return;
    }
    if (event.button) return;
    canvas.setPointerCapture(event.pointerId);
    pressed = true;
    const at = local(event);
    pointer = at;
    pressedAt = at;
    lastAt = at;
    dragging = false;
    if (tool === 'erase') {
      erasing = { bars: new Set(), labels: new Set(), spokes: new Set() };
      trail.start(at);
      eraseNear(at);
    }
    if (tool === 'select') {
      picked = hitAt(at, 6);
      if (!picked) boxing = { adding: event.shiftKey, from: at, to: at };
    }
    if (isBar && tool === 'draw') {
      const slot = slotAt(at);
      if (slot <= model.bars.length && slot < BARS_MAX)
        live = { slot, value: valueAt(at) };
    }
    redraw();
  });
  canvas.addEventListener('pointermove', (event) => {
    const at = local(event);
    if (touches.has(event.pointerId)) touches.set(event.pointerId, at);
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      // Fingers apart zoom in: a lower top.
      if (distance) zoomBy(pinch / distance);
      pinch = distance;
      return;
    }
    pointer = pressed || event.pointerType === 'mouse' ? at : null;
    if (erasing && pressed) {
      for (const px of alongDrag(lastAt, at)) eraseNear(px);
      trail.add(at);
    }
    lastAt = at;
    if (boxing && pressed) {
      boxing.to = at;
      redraw();
      return;
    }
    const held = picked;
    if (tool === 'select' && pressed && held) {
      dragging ||=
        Math.hypot(at[0] - pressedAt[0], at[1] - pressedAt[1]) >=
        PIXELS_TO_DRAG;
      if (dragging && held.kind === 'bar') {
        const slot = model.bars.findIndex(({ id }) => id === held.id);
        if (slot >= 0) live = { slot, value: valueAt(at) };
      } else if (dragging) {
        const angle = angleAt(at);
        // A line stays off the others; a label goes anywhere round.
        const taken =
          held.kind === 'spoke' &&
          angle !== held.angle &&
          model.spokes.includes(angle);
        if (!taken) turning = { angle, moved: true };
      }
      canvas.style.cursor = dragging ? 'grabbing' : '';
    } else if (live && pressed) live = { ...live, value: valueAt(at) };
    if (tool === 'select' && !pressed && event.pointerType === 'mouse')
      canvas.style.cursor = hitAt(at, 6) ? 'grab' : '';
    redraw();
  });
  canvas.addEventListener('pointerup', (event) => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = 0;
    if (!pressed) return;
    pressed = false;
    const at = local(event);
    const gone = erasing;
    erasing = null;
    const turned = turning;
    turning = null;
    const box = boxing;
    boxing = null;
    const held = picked;
    canvas.style.cursor = '';
    // What Select ends up with: a box's catch, or the item clicked or dragged.
    if (box) {
      const dragged =
        Math.hypot(box.to[0] - box.from[0], box.to[1] - box.from[1]) >=
        PIXELS_TO_DRAG;
      const caught = dragged ? boxed(box.from, box.to) : [];
      chosen = box.adding
        ? [
            ...chosen,
            ...caught.filter((one) => !chosen.some((c) => same(c, one))),
          ]
        : caught;
    } else if (tool === 'select' && held) {
      const has = chosen.some((one) => same(one, held));
      if (dragging) chosen = has ? chosen : [held];
      else if (event.shiftKey)
        chosen = has
          ? chosen.filter((one) => !same(one, held))
          : [...chosen, held];
      else chosen = [held];
    }
    if (gone) {
      trail.end();
      if (gone.bars.size || gone.labels.size || gone.spokes.size)
        update({
          bars: model.bars.filter(({ id }) => !gone.bars.has(id)),
          fills: (model.fills ?? []).filter(
            ({ from }) => !gone.spokes.has(from)
          ),
          labels: model.labels.filter(({ id }) => !gone.labels.has(id)),
          spokes: model.spokes.filter((spoke) => !gone.spokes.has(spoke)),
        });
    } else if (turned && picked?.kind === 'spoke') {
      const { angle: from } = picked;
      const { angle: to } = turned;
      if (to !== from)
        update({
          fills: (model.fills ?? []).map((slice) =>
            slice.from === from ? { ...slice, from: to } : slice
          ),
          spokes: model.spokes.map((spoke) => (spoke === from ? to : spoke)),
        });
      picked = { angle: to, kind: 'spoke' };
      chosen = chosen.map((one) =>
        one.kind === 'spoke' && one.angle === from
          ? { angle: to, kind: 'spoke' }
          : one
      );
    } else if (turned && picked?.kind === 'label') {
      const { id } = picked;
      update({
        labels: model.labels.map((label) =>
          label.id === id ? { ...label, angle: turned.angle } : label
        ),
      });
    } else if (live) {
      const { slot, value } = live;
      live = null;
      const bar = model.bars[slot];
      if (bar && value)
        update({
          bars: model.bars.map((other, i) =>
            i === slot ? { ...other, value } : other
          ),
        });
      else if (bar) update({ bars: model.bars.filter((_, i) => i !== slot) });
      else if (value)
        update({
          bars: [
            ...model.bars,
            { fill: newFill(), id: crypto.randomUUID(), label: '', value },
          ],
        });
    } else if (tool === 'label') {
      commitLabel();
      openLabel(at);
    } else if (tool === 'fill') fillAt(at);
    else if (tool === 'draw' && !isBar && model.spokes.length < SPOKES_MAX) {
      const angle = angleAt(at);
      if (!model.spokes.includes(angle))
        update({ spokes: [...model.spokes, angle] });
    }
    if (event.pointerType !== 'mouse') pointer = null;
    redraw();
  });
  canvas.addEventListener('pointercancel', (event) => {
    touches.delete(event.pointerId);
    pinch = 0;
    pressed = false;
    live = null;
    turning = null;
    erasing = null;
    boxing = null;
    trail.end();
    pointer = null;
    redraw();
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    redraw();
  });

  /** With their keys, shown in their tooltips (Epo 2026-11-08). */
  const tools: { icon: string; id: Tool; key: string; label: () => string }[] =
    [
      {
        icon: 'select',
        id: 'select',
        key: 'V',
        label: m.drawing_board_select,
      },
      ...(isBar
        ? [
            {
              icon: 'bars',
              id: 'draw' as const,
              key: 'D',
              label: m.drawing_board_bars,
            },
          ]
        : [
            {
              icon: 'pie',
              id: 'draw' as const,
              key: 'D',
              label: m.drawing_board_pie,
            },
            {
              icon: 'fill',
              id: 'fill' as const,
              key: 'F',
              label: m.drawing_board_fill_slice,
            },
          ]),
      {
        icon: 'label',
        id: 'label',
        key: 'T',
        label: m.drawing_board_chart_label,
      },
      {
        icon: 'erase',
        id: 'erase',
        key: 'E',
        label: m.drawing_board_erase_mark,
      },
    ];
  const pick = (id: Tool) => {
    commitLabel();
    picked = null;
    chosen = [];
    tool = id;
    pointer = null;
    drawControls();
    redraw();
  };

  const drawControls = () => {
    root.dataset.tool = tool;
    render(
      html`${
        isBar
          ? html`<div class="capy-chart-axis">
              <label>
                ${m.drawing_board_axis_to()}
                <input
                  inputmode="decimal"
                  type="text"
                  .value=${String(model.axisMax)}
                  @change=${(event: Event) => setAxis(event, 'axisMax')}
                />
              </label>
              <label>
                ${m.drawing_board_axis_step()}
                <input
                  inputmode="decimal"
                  type="text"
                  .value=${String(model.axisStep)}
                  @change=${(event: Event) => setAxis(event, 'axisStep')}
                />
              </label>
            </div>`
          : nothing
      }
        ${
          typing
            ? html`<input
                aria-label=${m.drawing_board_chart_label()}
                class="capy-chart-label"
                maxlength=${LABEL_LENGTH_MAX}
                style="left:${typing.x}px;top:${typing.y}px"
                type="text"
                .value=${typing.text}
                @blur=${commitLabel}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter') commitLabel();
                }}
              />`
            : nothing
        }
        ${
          !isBar && tool === 'draw' && model.spokes.length
            ? html`<button
                class="capy-plane-finish"
                type="button"
                @click=${() => {
                  tool = 'fill';
                  pointer = null;
                  drawControls();
                  redraw();
                }}
              >
                ${m.drawing_board_finish_slicing()}
              </button>`
            : nothing
        }
        <div class="capy-plane-tools">
          ${
            (isBar && tool === 'draw') || tool === 'fill'
              ? fillRow(gfx, drawControls)
              : nothing
          }
          <div class="capy-plane-row">
            ${tools.map(
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

setChartEditor(openChartEditor);
