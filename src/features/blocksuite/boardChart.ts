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
import {
  BAR_SHARE,
  barPlot,
  CARD_PADS,
  type ChartBar,
  type ChartData,
  type ChartKind,
  INK,
  NUMBER,
  onScreen,
  type PieLabel,
  pieCircle,
  TEXT,
} from './boardData';
import { ticks } from './boardGeometry';
import type { Frame } from './boardPlane';

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
