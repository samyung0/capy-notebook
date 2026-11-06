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
import type { Color } from '@blocksuite/affine/model';
import {
  field,
  type GfxController,
  GfxElementModelView,
  GfxPrimitiveElementModel,
  GfxViewInteractionExtension,
} from '@blocksuite/affine/std/gfx';
import { ticks } from './boardGeometry';
import type { Frame } from './boardPlane';

/** A bar or pie chart is a card of its own: a coordinate means nothing on either (Epo
 * 2026-11-06). The student reads the table and builds it by hand. */
export type ChartKind = 'bar' | 'pie';
export type ChartBar = {
  fill: Color;
  id: string;
  label: string;
  value: number;
};
export type PieLabel = { angle: number; id: string; text: string };

export type ChartData = {
  axisMax: number;
  axisStep: number;
  bars: ChartBar[];
  kind: ChartKind;
  labels: PieLabel[];
  spokes: number[];
};

/** Room around the chart, as a card and in the editor. */
export type Pads = { bottom: number; left: number; right: number; top: number };
const CARD_PADS: Record<ChartKind, Pads> = {
  bar: { bottom: 30, left: 36, right: 12, top: 14 },
  pie: { bottom: 14, left: 14, right: 14, top: 14 },
};

const INK = '#000';
const TEXT = '#1d1d1f';
const NUMBER = '#55555b';

export const BARS_MAX = 24;
export const SPOKES_MAX = 60;
export const LABELS_MAX = 60;
export const LABEL_LENGTH_MAX = 24;
export const AXIS_MAX = 1e9;
/** A bar's width within its slot. */
const BAR_SHARE = 0.56;

/** Where a bar chart's bars go. `slots` is one more than the bars in the editor, so
 * there's a free place to start the next. */
export function barPlot(frame: Frame, pads: Pads, slots: number) {
  const left = frame.x + pads.left;
  const top = frame.y + pads.top;
  const width = Math.max(1, frame.w - pads.left - pads.right);
  const height = Math.max(1, frame.h - pads.top - pads.bottom);
  return { base: top + height, height, left, slotW: width / slots, top, width };
}

export function pieCircle(frame: Frame, pads: Pads) {
  const width = Math.max(2, frame.w - pads.left - pads.right);
  const height = Math.max(2, frame.h - pads.top - pads.bottom);
  return {
    cx: frame.x + pads.left + width / 2,
    cy: frame.y + pads.top + height / 2,
    r: Math.min(width, height) / 2,
  };
}

/** A clockwise angle from 12 o'clock to a point on the screen, where y goes down. */
const onScreen = (cx: number, cy: number, r: number, degrees: number) => {
  const turn = (degrees * Math.PI) / 180;
  return [cx + r * Math.sin(turn), cy - r * Math.cos(turn)] as const;
};

export function drawChart(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  chart: ChartData,
  resolve: (color: Color) => string,
  pads = CARD_PADS[chart.kind],
  slots = Math.max(chart.bars.length, 1)
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.clip();
  ctx.font = '12px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (chart.kind === 'bar') {
    const { base, height, left, slotW, top, width } = barPlot(
      frame,
      pads,
      slots
    );
    const Y = (value: number) => base - (height * value) / chart.axisMax;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (const value of ticks(0, chart.axisMax, chart.axisStep)) {
      ctx.strokeStyle = '#e4e4e2';
      ctx.beginPath();
      ctx.moveTo(left, Y(value));
      ctx.lineTo(left + width, Y(value));
      ctx.stroke();
      ctx.fillStyle = NUMBER;
      ctx.fillText(`${Number(value.toPrecision(10))}`, left - 7, Y(value));
    }
    ctx.textAlign = 'center';
    ctx.lineWidth = 2;
    for (const [i, bar] of chart.bars.entries()) {
      const w = slotW * BAR_SHARE;
      const x = left + slotW * i + (slotW - w) / 2;
      const y = Y(Math.min(bar.value, chart.axisMax));
      ctx.fillStyle = resolve(bar.fill);
      ctx.fillRect(x, y, w, base - y);
      ctx.strokeStyle = INK;
      ctx.strokeRect(x, y, w, base - y);
      ctx.fillStyle = TEXT;
      ctx.fillText(bar.label, x + w / 2, base + 14);
    }
    ctx.strokeStyle = '#6f6f6c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, base);
    ctx.lineTo(left + width, base);
    ctx.stroke();
  } else {
    const { cx, cy, r } = pieCircle(frame, pads);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    for (const spoke of chart.spokes) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(...onScreen(cx, cy, r, spoke));
      ctx.stroke();
    }
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    for (const { angle, text } of chart.labels)
      ctx.fillText(text, ...onScreen(cx, cy, r * LABEL_REACH, angle));
  }
  ctx.restore();
  ctx.strokeStyle = '#d9d9d6';
  ctx.lineWidth = 1;
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
}

/** How far out of a pie's centre its labels sit. */
export const LABEL_REACH = 0.62;

export class ChartElementModel extends GfxPrimitiveElementModel<{
  axisMax: number;
  axisStep: number;
  bars: ChartBar[];
  index: string;
  kind: ChartKind;
  labels: PieLabel[];
  rotate: number;
  seed: number;
  spokes: number[];
  xywh: SerializedXYWH;
}> {
  get type() {
    return 'chart';
  }

  override containsBound(bounds: Bound) {
    return Bound.deserialize(this.xywh).points.some((point) =>
      bounds.containsPoint(point as IVec)
    );
  }

  /** The eraser asks this, so it leaves a card alone. */
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

  @field()
  accessor axisMax = 10;

  @field()
  accessor axisStep = 2;

  @field()
  accessor bars: ChartBar[] = [];

  @field()
  accessor kind: ChartKind = 'bar';

  @field()
  accessor labels: PieLabel[] = [];

  @field(0)
  accessor rotate = 0;

  @field()
  accessor spokes: number[] = [];

  @field()
  accessor xywh: SerializedXYWH = '[0,0,16,16]';
}

// The surface builds its elements from this map when a board opens.
Object.assign(elementsCtorMap, { chart: ChartElementModel });

const chartRenderer: ElementRenderer<ChartElementModel> = (
  model,
  ctx,
  matrix,
  renderer
) => {
  const [, , w, h] = model.deserializedXYWH;
  ctx.setTransform(matrix);
  drawChart(ctx, { h, w, x: 0, y: 0 }, model, (color) =>
    renderer.getColorValue(color, 'transparent', true)
  );
};

/** The full-screen editor, set by its module so this one stays light. */
let openEditor: (gfx: GfxController, model: ChartElementModel) => void = () =>
  undefined;
export function setChartEditor(open: typeof openEditor) {
  openEditor = open;
}
export const openChart = (gfx: GfxController, model: ChartElementModel) =>
  openEditor(gfx, model);

class ChartElementView extends GfxElementModelView<ChartElementModel> {
  static override type = 'chart';

  override onCreated() {
    super.onCreated();
    this.on('dblclick', () => openEditor(this.gfx, this.model));
  }
}

const chartInteraction = GfxViewInteractionExtension<ChartElementView>(
  'chart',
  {
    handleRotate() {
      return {
        beforeRotate(context) {
          context.set({ rotatable: false });
        },
      };
    },
    resizeConstraint: {
      maxHeight: 4000,
      maxWidth: 4000,
      minHeight: 120,
      minWidth: 120,
    },
  }
);

export const chartExtensions = [
  ElementRendererExtension('chart', chartRenderer),
  ChartElementView,
  chartInteraction,
];

export function addChart(gfx: GfxController, box: Bound, kind: ChartKind) {
  return gfx.surface?.addElement({
    axisMax: 10,
    axisStep: 2,
    bars: [],
    kind,
    labels: [],
    // A pie starts from 12 o'clock.
    spokes: kind === 'pie' ? [0] : [],
    type: 'chart',
    xywh: box.serialize(),
  });
}
