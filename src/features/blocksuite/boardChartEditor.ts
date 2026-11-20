import {
  EditPropsStore,
  ThemeProvider,
} from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import {
  Delete02Icon,
  LeftToRightListBulletIcon,
  MoreVerticalIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { html, nothing, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import {
  CORNER_CURSOR,
  draggedSize,
  drawChip,
  drawTextFrame,
  frameCornerAt,
} from '@/features/graph/overlay';
import { alongDrag, ERASER_SIZE } from '@/features/graph/tools';
import { m } from '@/i18n';
import {
  type ChartElementModel,
  drawChart,
  setChartEditor,
} from './boardChart';
import {
  AXIS_MAX,
  BAR_SHARE,
  BARS_MAX,
  barPlot,
  CHART_TEXT,
  type ChartBar,
  LABEL_LENGTH_MAX,
  LABELS_MAX,
  PAPER,
  type Pads,
  type PieLabel,
  pieCircle,
  SPOKES_MAX,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
} from './boardData';
import { openBoardEditor, toolTip } from './boardEditorShell';
import { EraserTrail } from './boardEraser';
import { clockAngle, snapTo, tidy, type Vec } from './boardGeometry';
import { boardKindOf, fillRow, hugeIcon, mathsIcon } from './boardTools';

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
/** The data pane open or closed, as last chosen this session; until then open on a
 * wide screen (Epo 2026-11-13, B1 and P1, as the plane's list). */
let listChoice: boolean | null = null;
/** Under this width the pane is a sheet over the chart's lower half. */
const SHEET_BELOW = 640;
/** Where a pie label inside the pie is put when a slice is named. */
const NAME_REACH = 0.62;

/** A pie's slices clockwise from its lines: each from a line to the next. */
type Slice = { from: number; size: number };
const slicesOf = (spokes: number[]): Slice[] => {
  const sorted = [...spokes].sort((a, b) => a - b);
  return sorted.map((from, i) => ({
    from,
    size: (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360) - from,
  }));
};
/** Whether a clockwise angle falls in a slice. */
const inSlice = ({ from, size }: Slice, angle: number) =>
  (((angle - from) % 360) + 360) % 360 < size;
/** A slice's size as a share, to a tenth of a percent. */
const shareOf = ({ size }: Slice) => Math.round((size / 3.6) * 10) / 10;

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
    reach?: number;
    barId?: string;
    id?: string;
    size?: number;
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
  /** How far a pie's line being dragged has turned; written when it lifts. */
  let turning: { by: number } | null = null;
  /** How far a pie's label being dragged has moved, in pixels: it goes anywhere, in
   * the pie or out of it (Epo 2026-11-13). */
  let shifting: Vec | null = null;
  /** The size the framed label's corner has been pulled to; written when it lifts. */
  let resizing: { corner: number; id: string; size: number } | null = null;
  /** What a Select drag moves: every chosen item of the held one's kind when it's one
   * of them, so several move together (Epo 2026-11-09), else just it. */
  const groupOf = (held: Picked) =>
    chosen.some((one) => same(one, held))
      ? chosen.filter((one) => one.kind === held.kind)
      : [held];
  const spin = (angle: number, by: number) =>
    (((angle + by) % 360) + 360) % 360;
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
  const workspace = boardKindOf(gfx.std) === 'workspace';
  /** The row under the mouse, its bar, slice (`s` and its line) or label lit. */
  let hot: string | null = null;
  /** The row whose ⋮ menu is open, and how far down the pane it sits. */
  let menuFor: { key: string; top: number } | null = null;
  /** A row's swatch picked: the next fill picked goes to that bar or slice. */
  let recolour: { bar: string } | { from: number } | null = null;
  /** The row whose first field takes the caret once drawn (one just added). */
  let focusRow: string | null = null;

  const shell = openBoardEditor(gfx, model.id, {
    // A pie keeps its first line at 12 o'clock, as a new one starts.
    clear: {
      empty: () =>
        !(model.bars.length || model.labels.length) &&
        model.spokes.length <= (model.kind === 'pie' ? 1 : 0),
      run: () => {
        typing = null;
        chosen = [];
        picked = null;
        update({
          bars: [],
          fills: [],
          labels: [],
          spokes: model.kind === 'pie' ? [0] : [],
        });
        drawControls();
        redraw();
      },
    },
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
      if (menuFor) {
        menuFor = null;
        drawControls();
        return true;
      }
      // A row being typed in goes back as it was.
      const field = document.activeElement;
      if (
        field instanceof HTMLInputElement &&
        field.closest('.capy-plane-list')
      ) {
        field.value = field.dataset.value ?? field.value;
        field.blur();
        return true;
      }
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

  const listOpen = () =>
    workspace && (listChoice ?? box().width >= SHEET_BELOW);
  const listLayout = () =>
    listOpen() ? (box().width < SHEET_BELOW ? 'sheet' : 'floating') : '';
  /** The chart's room: beside the floating pane, or above the phone's sheet. */
  const pads = (): Pads => {
    const room = ownPads();
    const layout = listLayout();
    if (layout === 'floating') return { ...room, left: room.left + 308 };
    if (layout === 'sheet')
      return { ...room, bottom: room.bottom + box().height * 0.48 };
    return room;
  };
  const ownPads = (): Pads => {
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
  /** Where a pie label sits on screen. */
  const labelPoint = ({
    angle,
    reach,
  }: Pick<PieLabel, 'angle' | 'reach'>): Vec => {
    const { cx, cy, r } = pieCircle(screen(), pads());
    const turn = (angle * Math.PI) / 180;
    return [cx + r * reach * Math.sin(turn), cy - r * reach * Math.cos(turn)];
  };
  /** A pie label's place for a point on screen, kept on the card. */
  const labelPlace = ([px, py]: Vec) => {
    const { h, w } = screen();
    const { cx, cy, r } = pieCircle(screen(), pads());
    const x = Math.min(w - 8, Math.max(8, px));
    const y = Math.min(h - 8, Math.max(8, py));
    // Unrounded, unlike a line's whole degree, so a far label doesn't jump.
    const degrees = (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
    return {
      angle: (degrees + 360) % 360,
      reach: Math.hypot(x - cx, y - cy) / r,
    };
  };
  /** Where a pie label's text sits on screen: its width by a line, round its point. */
  const labelBox = (label: PieLabel) => {
    const [x, y] = labelPoint(label);
    const size = label.size ?? CHART_TEXT;
    ctx.save();
    ctx.font = `${size}px Arial, sans-serif`;
    const w = ctx.measureText(label.text).width;
    ctx.restore();
    const h = size * 1.2;
    return { h, w, x: x - w / 2, y: y - h / 2 };
  };
  /** The pie label under a point, if any: on its text, or near its point. */
  const labelAt = ([x, y]: Vec) =>
    model.labels.find((label) => {
      const [lx, ly] = labelPoint(label);
      const box = labelBox(label);
      return (
        Math.hypot(x - lx, y - ly) < PIXELS_TO_LABEL ||
        (x >= box.x - 4 &&
          x <= box.x + box.w + 4 &&
          y >= box.y - 4 &&
          y <= box.y + box.h + 4)
      );
    });
  /** The one label Select has picked, which wears the board's frame (Epo 2026-11-13). */
  const framed = (labels = model.labels) => {
    const [one] = chosen;
    if (tool !== 'select' || chosen.length !== 1 || one.kind !== 'label')
      return null;
    if (typing?.id === one.id) return null;
    return labels.find(({ id }) => id === one.id) ?? null;
  };
  const cornerAt = (px: Vec) => {
    const label = framed();
    const corner = label ? frameCornerAt(labelBox(label), px) : null;
    return label && corner !== null ? { corner, id: label.id } : null;
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
      .filter((label) => inside(labelPoint(label)))
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
      const turned =
        turning && picked && groupOf(picked).some((other) => same(other, one));
      const angle = turned && turning ? spin(one.angle, turning.by) : one.angle;
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
      if (held && turning) drawChip(ctx, `${angle}°`, x, y, area.w);
      return;
    }
    if (one.kind === 'label') {
      const { id } = one;
      const label = labels.find((each) => each.id === id);
      if (!label) return;
      const box = labelBox(label);
      ctx.fillStyle = HALO;
      ctx.fillRect(box.x - 6, box.y - 4, box.w + 12, box.h + 8);
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x - 6, box.y - 4, box.w + 12, box.h + 8);
    }
  };

  /** The chart with the press in progress: the bar being set, and what a Select drag
   * moves. Chosen bars go up or down by as much as the held one, chosen lines and
   * labels round by as far. */
  const moving = () => {
    let { bars, fills = [], labels, spokes } = model;
    if (live) {
      const { slot, value } = live;
      const by = value - (bars[slot]?.value ?? value);
      const along = new Set(
        picked?.kind === 'bar'
          ? groupOf(picked).flatMap((one) => (one.kind === 'bar' ? one.id : []))
          : []
      );
      bars = bars.map((bar, i) => {
        if (i === slot) return { ...bar, value };
        if (!along.has(bar.id)) return bar;
        return {
          ...bar,
          value: Math.min(AXIS_MAX, Math.max(0, tidy(bar.value + by))),
        };
      });
      if (slot >= bars.length)
        bars = [...bars, { fill: newFill(), id: '', label: '', value }];
    }
    if (turning && picked) {
      const { by } = turning;
      const group = groupOf(picked);
      const angles = new Set(
        group.flatMap((one) => (one.kind === 'spoke' ? one.angle : []))
      );
      spokes = spokes.map((spoke) =>
        angles.has(spoke) ? spin(spoke, by) : spoke
      );
      fills = fills.map((slice) =>
        angles.has(slice.from)
          ? { ...slice, from: spin(slice.from, by) }
          : slice
      );
    }
    if (shifting && picked) {
      const [dx, dy] = shifting;
      const ids = new Set(
        groupOf(picked).flatMap((one) => (one.kind === 'label' ? one.id : []))
      );
      labels = labels.map((label) => {
        if (!ids.has(label.id)) return label;
        const [x, y] = labelPoint(label);
        return { ...label, ...labelPlace([x + dx, y + dy]) };
      });
    }
    if (resizing) {
      const { id, size } = resizing;
      labels = labels.map((label) =>
        label.id === id ? { ...label, size } : label
      );
    }
    return { bars, fills, labels, spokes };
  };

  const draw = () => {
    const { height, width } = shell.sizeCanvas();
    const area = { h: height, w: width, x: 0, y: 0 };
    let { bars, fills, labels, spokes } = moving();
    if (erasing) {
      const gone = erasing;
      bars = bars.filter(({ id }) => !gone.bars.has(id));
      labels = labels.filter(({ id }) => !gone.labels.has(id));
      spokes = spokes.filter((spoke) => !gone.spokes.has(spoke));
      fills = fills.filter((slice) => !gone.spokes.has(slice.from));
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
    const inFrame = framed(labels);
    for (const one of chosen)
      if (one.kind !== 'label' || one.id !== inFrame?.id)
        drawPicked(one, area, bars, labels, spokes);
    if (inFrame)
      drawTextFrame(
        ctx,
        labelBox(inFrame),
        getComputedStyle(canvas).getPropertyValue('--affine-primary-color'),
        PAPER[resolve.theme].paper
      );
    // A hovered row lights its bar, slice or label.
    if (hot?.startsWith('s:')) {
      const from = Number(hot.slice(2));
      const slice = slicesOf(spokes).find((one) => one.from === from);
      if (slice) {
        const { cx, cy, r } = pieCircle(area, pads());
        const turn = (deg: number) => ((deg - 90) * Math.PI) / 180;
        for (const [colour, width] of [
          [HALO, 10],
          [BLUE, 2],
        ] as const) {
          ctx.strokeStyle = colour;
          ctx.lineWidth = width;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, r, turn(slice.from), turn(slice.from + slice.size));
          ctx.closePath();
          ctx.stroke();
        }
      }
    } else if (hot && bars.some(({ id }) => id === hot))
      drawPicked({ id: hot, kind: 'bar' }, area, bars, labels, spokes);
    else if (hot && labels.some(({ id }) => id === hot))
      drawPicked({ id: hot, kind: 'label' }, area, bars, labels, spokes);
    if (
      picked &&
      (turning || shifting) &&
      !chosen.some((one) => picked && same(one, picked))
    )
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
      // A new label goes where it's clicked.
      const label = labelAt(at);
      if (!label && model.labels.length >= LABELS_MAX) return;
      const place = label ?? labelPlace(at);
      const [x, y] = labelPoint(place);
      typing = {
        angle: place.angle,
        id: label?.id,
        reach: place.reach,
        size: label?.size,
        text: label?.text ?? '',
        x,
        y,
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
              reach: open.reach ?? 0,
              ...(open.size && { size: open.size }),
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
    // A second finger while a label's corner is pulled leaves the pull alone.
    if (resizing) return;
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
    const pulled = tool === 'select' && cornerAt(at);
    if (pulled) {
      const label = model.labels.find(({ id }) => id === pulled.id);
      picked = { id: pulled.id, kind: 'label' };
      resizing = { ...pulled, size: label?.size ?? CHART_TEXT };
    } else if (tool === 'select') {
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
    const label =
      resizing && model.labels.find(({ id }) => id === resizing?.id);
    if (resizing && label && pressed) {
      resizing.size = draggedSize(
        label.size ?? CHART_TEXT,
        labelPoint(label),
        pressedAt,
        at,
        [TEXT_SIZE_MIN, TEXT_SIZE_MAX]
      );
      canvas.style.cursor = CORNER_CURSOR[resizing.corner];
    } else if (tool === 'select' && pressed && held) {
      dragging ||=
        Math.hypot(at[0] - pressedAt[0], at[1] - pressedAt[1]) >=
        PIXELS_TO_DRAG;
      if (dragging && held.kind === 'bar') {
        const slot = model.bars.findIndex(({ id }) => id === held.id);
        if (slot >= 0) live = { slot, value: valueAt(at) };
      } else if (dragging && held.kind === 'label')
        shifting = [at[0] - pressedAt[0], at[1] - pressedAt[1]];
      else if (dragging && held.kind === 'spoke') {
        const by = angleAt(at) - held.angle;
        // Lines stay off the others.
        const group = groupOf(held).flatMap((one) =>
          one.kind === 'spoke' ? one.angle : []
        );
        const taken = group.some((angle) => {
          const to = spin(angle, by);
          return model.spokes.includes(to) && !group.includes(to);
        });
        if (!taken) turning = { by };
      }
      canvas.style.cursor = dragging ? 'grabbing' : '';
    } else if (live && pressed) live = { ...live, value: valueAt(at) };
    if (tool === 'select' && !pressed && event.pointerType === 'mouse') {
      const corner = cornerAt(at);
      canvas.style.cursor = corner
        ? CORNER_CURSOR[corner.corner]
        : hitAt(at, 6)
          ? 'grab'
          : '';
    }
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
    const next = moving();
    const turned = turning;
    turning = null;
    const shifted = shifting;
    shifting = null;
    const sized = resizing;
    resizing = null;
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
    } else if (turned && held?.kind === 'spoke') {
      const { by } = turned;
      if (by) update({ fills: next.fills, spokes: next.spokes });
      // The selection follows its lines round.
      const angles = groupOf(held).flatMap((one) =>
        one.kind === 'spoke' ? one.angle : []
      );
      picked = { angle: spin(held.angle, by), kind: 'spoke' };
      chosen = chosen.map((one) =>
        one.kind === 'spoke' && angles.includes(one.angle)
          ? { angle: spin(one.angle, by), kind: 'spoke' }
          : one
      );
    } else if (shifted && held?.kind === 'label') {
      update({ labels: next.labels });
    } else if (sized) {
      const was = model.labels.find(({ id }) => id === sized.id)?.size;
      if (sized.size !== (was ?? CHART_TEXT)) update({ labels: next.labels });
    } else if (live) {
      const { slot, value } = live;
      live = null;
      // A bar taken down to nothing goes.
      if (model.bars[slot])
        update({ bars: next.bars.filter((bar) => bar.value) });
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
    shifting = null;
    resizing = null;
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
    recolour = null;
    picked = null;
    chosen = [];
    tool = id;
    pointer = null;
    drawControls();
    redraw();
  };

  // The data pane (Epo 2026-11-13, B1 and P1): a bar's label and value, a slice's
  // name and share, typed in rows as the plane's list. Workspace canvases only.
  const toggleList = () => {
    listChoice = !listOpen();
    menuFor = null;
    drawControls();
    redraw();
  };
  const lightRow = (key: string | null) => {
    if (hot === key) return;
    hot = key;
    redraw();
  };
  /** A slice's name: the first label inside the pie within it. */
  const nameOf = (slice: Slice) =>
    model.labels.find(
      ({ angle, reach }) => reach <= 1 && inSlice(slice, angle)
    );
  const colourOf = (fill: ChartBar['fill'] | undefined) =>
    fill ? resolve.getColorValue(fill, 'transparent', true) : 'transparent';
  const setBar = (id: string, change: Partial<ChartBar>) =>
    update({
      bars: model.bars.map((bar) =>
        bar.id === id ? { ...bar, ...change } : bar
      ),
    });
  /** A typed value; past the axis's top it raises the top to the next line. */
  const setValue = (bar: ChartBar, field: HTMLInputElement) => {
    const value = Number(field.value.replace(/[−–]/g, '-'));
    if (!(Number.isFinite(value) && value >= 0 && value <= AXIS_MAX)) {
      field.value = String(bar.value);
      return;
    }
    let { axisMax, axisStep } = model;
    if (value > axisMax) {
      const lifted = Number(
        (Math.ceil(value / axisStep - 1e-9) * axisStep).toPrecision(12)
      );
      if (lifted / axisStep <= AXIS_LINES_MAX) axisMax = lifted;
      else ({ axisMax, axisStep } = niceAxis(value));
    }
    update({
      axisMax,
      axisStep,
      bars: model.bars.map((one) =>
        one.id === bar.id ? { ...one, value } : one
      ),
    });
  };
  const addBar = () => {
    if (model.bars.length >= BARS_MAX) return;
    const id = crypto.randomUUID();
    focusRow = id;
    update({
      bars: [
        ...model.bars,
        { fill: newFill(), id, label: '', value: model.axisStep },
      ],
    });
  };
  /** A slice's share typed: its closing line moves, the slices after it keep their
   * sizes and the last takes up the rest (the last one's own share moves its opening
   * line). Labels inside a slice keep their place in it; fills follow their line. */
  const setShare = (index: number, field: HTMLInputElement) => {
    const slices = slicesOf(model.spokes);
    const size = Math.round(Number(field.value.replace('%', '')) * 3.6);
    const last = slices.length - 1;
    const delta = size - slices[index]?.size;
    const giver = index < last ? last : last - 1;
    if (
      !(last > 0 && Number.isFinite(delta) && size >= 1) ||
      slices[giver].size - delta < 1
    ) {
      field.value = String(shareOf(slices[index]));
      return;
    }
    if (!delta) return;
    const moved = slices.map(({ from, size: was }, i) => {
      const start =
        index < last
          ? i > index
            ? from + delta
            : from
          : i === last
            ? from - delta
            : from;
      const grow = i === index ? delta : i === giver ? -delta : 0;
      return { from: start, size: was + grow };
    });
    const spin = (angle: number) => ((angle % 360) + 360) % 360;
    update({
      fills: (model.fills ?? []).map((fill) => {
        const i = slices.findIndex(({ from }) => from === fill.from);
        return i < 0 ? fill : { ...fill, from: spin(moved[i].from) };
      }),
      labels: model.labels.map((label) => {
        const i =
          label.reach <= 1
            ? slices.findIndex((slice) => inSlice(slice, label.angle))
            : -1;
        if (i < 0) return label;
        const into = spin(label.angle - slices[i].from) / slices[i].size;
        return { ...label, angle: spin(moved[i].from + into * moved[i].size) };
      }),
      spokes: moved.map(({ from }) => spin(from)),
    });
  };
  const nameSlice = (slice: Slice, field: HTMLInputElement) => {
    const text = field.value.trim().slice(0, LABEL_LENGTH_MAX);
    const named = nameOf(slice);
    if (named)
      update({
        labels: text
          ? model.labels.map((label) =>
              label.id === named.id ? { ...label, text } : label
            )
          : model.labels.filter(({ id }) => id !== named.id),
      });
    else if (text && model.labels.length < LABELS_MAX)
      update({
        labels: [
          ...model.labels,
          {
            angle: (slice.from + slice.size / 2) % 360,
            id: crypto.randomUUID(),
            reach: NAME_REACH,
            text,
          },
        ],
      });
  };
  /** "+ Slice": the last slice halved, or a first line at 12 o'clock. */
  const addSlice = () => {
    const slices = slicesOf(model.spokes);
    const last = slices.at(-1);
    if (!last) {
      focusRow = 's:0';
      update({ spokes: [0] });
      return;
    }
    if (last.size < 2 || model.spokes.length >= SPOKES_MAX) return;
    const from = (last.from + Math.floor(last.size / 2)) % 360;
    focusRow = `s:${from}`;
    update({ spokes: [...model.spokes, from] });
  };
  const textOf = (field: HTMLInputElement) =>
    field.value.trim().slice(0, LABEL_LENGTH_MAX);
  const setLabel = (id: string, field: HTMLInputElement) => {
    const text = textOf(field);
    update({
      labels: text
        ? model.labels.map((label) =>
            label.id === id ? { ...label, text } : label
          )
        : model.labels.filter((label) => label.id !== id),
    });
  };
  /** ⋮ Delete: a bar, a label, or a slice's opening line (it joins the one before). */
  const removeRow = (key: string) => {
    hot = null;
    if (key.startsWith('s:')) {
      const from = Number(key.slice(2));
      update({
        fills: (model.fills ?? []).filter((fill) => fill.from !== from),
        spokes: model.spokes.filter((spoke) => spoke !== from),
      });
    } else if (model.bars.some(({ id }) => id === key))
      update({ bars: model.bars.filter(({ id }) => id !== key) });
    else update({ labels: model.labels.filter(({ id }) => id !== key) });
    redraw();
  };
  /** A swatch picked: the fill row opens for it, and its next pick goes there. */
  const pickSwatch = (target: { bar: string } | { from: number }) => {
    commitLabel();
    recolour = target;
    tool = isBar ? 'draw' : 'fill';
    drawControls();
    redraw();
  };
  const recolourPicked = () => {
    const target = recolour;
    recolour = null;
    if (!target) return;
    const fill = newFill();
    if ('bar' in target) setBar(target.bar, { fill });
    else {
      const others = (model.fills ?? []).filter(
        (slice) => slice.from !== target.from
      );
      update({
        fills:
          fill === 'transparent'
            ? others
            : [...others, { fill, from: target.from }],
      });
    }
  };
  const field = (
    label: string,
    value: string,
    commit: (field: HTMLInputElement) => void,
    numeric = false
  ) =>
    html`<input
      aria-label=${label}
      class=${numeric ? 'num' : ''}
      data-value=${value}
      inputmode=${numeric ? 'decimal' : 'text'}
      maxlength=${numeric ? 12 : LABEL_LENGTH_MAX}
      type="text"
      .value=${value}
      @change=${(event: Event) => commit(event.target as HTMLInputElement)}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
      }}
    />`;
  const more = (key: string) =>
    html`<button
      aria-label=${m.a11y_more_actions()}
      class="more"
      type="button"
      @click=${(event: MouseEvent) => {
        const list = controls.querySelector('.capy-plane-list');
        const button = event.currentTarget as HTMLElement;
        menuFor =
          menuFor?.key === key || !list
            ? null
            : {
                key,
                top:
                  button.getBoundingClientRect().bottom -
                  list.getBoundingClientRect().top +
                  4,
              };
        drawControls();
      }}
    >
      ${hugeIcon(MoreVerticalIcon)}
    </button>`;
  const swatch = (colour: string, target: { bar: string } | { from: number }) =>
    html`<button
      aria-label=${m.drawing_board_fill()}
      class="swatch"
      style="background:${colour}"
      type="button"
      @click=${() => pickSwatch(target)}
    ></button>`;
  const row = (key: string, cells: unknown, wide = true) =>
    html`<li
      class=${[wide ? 'capy-chart-row' : '', hot === key ? 'on' : ''].join(' ')}
      data-row=${key}
      @focusin=${() => lightRow(key)}
      @pointerenter=${() => lightRow(key)}
    >
      ${cells} ${more(key)}
    </li>`;
  const barRows = () =>
    repeat(
      model.bars,
      ({ id }) => id,
      (bar) =>
        row(
          bar.id,
          html`${swatch(colourOf(bar.fill), { bar: bar.id })}
          ${field(m.drawing_board_chart_label(), bar.label, (input) =>
            setBar(bar.id, { label: textOf(input) })
          )}
          ${field(
            m.drawing_board_chart_value(),
            String(bar.value),
            (input) => setValue(bar, input),
            true
          )}`
        )
    );
  const sliceRows = () => {
    const slices = slicesOf(model.spokes);
    const names = new Set(slices.map((slice) => nameOf(slice)?.id));
    const free = model.labels.filter(({ id }) => !names.has(id));
    return html`${repeat(
      slices,
      ({ from }) => from,
      (slice, index) =>
        row(
          `s:${slice.from}`,
          html`${swatch(
            colourOf(
              (model.fills ?? []).find(({ from }) => from === slice.from)?.fill
            ),
            { from: slice.from }
          )}
          ${field(
            m.drawing_board_chart_label(),
            nameOf(slice)?.text ?? '',
            (input) => nameSlice(slice, input)
          )}
          <span class="share">
            ${field(
              m.drawing_board_chart_share(),
              String(shareOf(slice)),
              (input) => setShare(index, input),
              true
            )}<small>%</small><small>${slice.size}°</small>
          </span>`
        )
    )}
    ${repeat(
      free,
      ({ id }) => id,
      (label) =>
        row(
          label.id,
          html`<span class="kind">${unsafeSVG(mathsIcon('label'))}</span>
            ${field(m.drawing_board_chart_label(), label.text, (input) =>
              setLabel(label.id, input)
            )}`,
          false
        )
    )}`;
  };
  const dataPane = (layout: string) =>
    html`<div
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
        ${isBar ? barRows() : sliceRows()}
      </ol>
      <button
        class="add"
        type="button"
        @click=${isBar ? addBar : addSlice}
      >
        ${hugeIcon(PlusSignIcon)}
        ${isBar ? m.drawing_board_chart_bar() : m.drawing_board_chart_slice()}
      </button>
      ${
        menuFor
          ? html`<div
              class="capy-menu-list"
              role="menu"
              style="top:${menuFor.top}px"
            >
              <button
                role="menuitem"
                type="button"
                @click=${() => {
                  const key = menuFor?.key;
                  menuFor = null;
                  if (key) removeRow(key);
                  drawControls();
                }}
              >
                ${hugeIcon(Delete02Icon)} ${m.action_delete()}
              </button>
            </div>`
          : nothing
      }
    </div>`;

  const drawControls = () => {
    root.dataset.tool = tool;
    const layout = listLayout();
    root.dataset.list = layout;
    render(
      html`${
        workspace
          ? html`<button
              aria-label=${m.drawing_board_chart_data()}
              aria-pressed=${layout !== ''}
              class="capy-plane-list-toggle"
              type="button"
              @click=${toggleList}
            >
              ${hugeIcon(LeftToRightListBulletIcon)}
            </button>`
          : nothing
      }
        ${layout ? dataPane(layout) : nothing}
        ${
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
                style="left:${typing.x}px;top:${typing.y}px;font-size:${typing.size ?? CHART_TEXT}px"
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
              ? fillRow(gfx, () => {
                  recolourPicked();
                  drawControls();
                })
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
    if (focusRow) {
      controls
        .querySelector<HTMLInputElement>(`[data-row="${focusRow}"] input`)
        ?.focus();
      focusRow = null;
    }
  };
  drawControls();
  // Past 640 px either way the pane turns card or sheet, and the chart moves over.
  new ResizeObserver(() => {
    if (root.dataset.list !== listLayout()) drawControls();
    redraw();
  }).observe(root);
  draw();
}

setChartEditor(openChartEditor);
