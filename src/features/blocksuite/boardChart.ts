import {
  type ElementRenderer,
  ElementRendererExtension,
  elementsCtorMap,
} from '@blocksuite/affine/blocks/surface';
import {
  type Bound,
  getPointsFromBoundWithRotation,
  type IVec,
  linePolygonIntersects,
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
import type { Frame } from '@/features/graph/model';
import {
  BAR_SHARE,
  barPlot,
  CARD_PADS,
  CHART_TEXT,
  type ChartBar,
  type ChartData,
  type ChartKind,
  cardPaper,
  filledSlices,
  onScreen,
  type Paper,
  type PieLabel,
  pieCircle,
  type SliceFill,
} from './boardData';
import { ticks } from './boardGeometry';

export function drawChart(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  chart: ChartData,
  resolve: (color: Color) => string,
  paper: Paper,
  pads = CARD_PADS[chart.kind],
  slots = Math.max(chart.bars.length, 1)
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = paper.paper;
  ctx.fill();
  ctx.clip();
  ctx.font = `${CHART_TEXT}px Arial, sans-serif`;
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
      ctx.strokeStyle = paper.rule;
      ctx.beginPath();
      ctx.moveTo(left, Y(value));
      ctx.lineTo(left + width, Y(value));
      ctx.stroke();
      ctx.fillStyle = paper.number;
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
      ctx.strokeStyle = paper.ink;
      ctx.strokeRect(x, y, w, base - y);
      ctx.fillStyle = paper.text;
      ctx.fillText(bar.label, x + w / 2, base + 14);
    }
    ctx.strokeStyle = paper.axis;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, base);
    ctx.lineTo(left + width, base);
    ctx.stroke();
  } else {
    const { cx, cy, r } = pieCircle(frame, pads);
    for (const { fill, from, to } of filledSlices(chart)) {
      // The canvas measures from 3 o'clock, the pie from 12.
      const at = (degrees: number) => ((degrees - 90) * Math.PI) / 180;
      ctx.fillStyle = resolve(fill);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, at(from), at(to));
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = paper.ink;
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
    ctx.fillStyle = paper.text;
    ctx.textAlign = 'center';
    for (const { angle, reach, size = CHART_TEXT, text } of chart.labels) {
      ctx.font = `${size}px Arial, sans-serif`;
      ctx.fillText(text, ...onScreen(cx, cy, r * reach, angle));
    }
  }
  ctx.restore();
  ctx.strokeStyle = paper.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
}

export class ChartElementModel extends GfxPrimitiveElementModel<{
  axisMax: number;
  axisStep: number;
  bars: ChartBar[];
  fills?: SliceFill[];
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

  @field()
  accessor axisMax = 10;

  @field()
  accessor axisStep = 2;

  @field()
  accessor bars: ChartBar[] = [];

  @field()
  /** Absent on a chart saved before pies had fills: a field's default only applies
   * to a new chart. */
  accessor fills: SliceFill[] | undefined = [];

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
  // Turned round its middle, as a formula card is.
  ctx.setTransform(
    matrix
      .translateSelf(w / 2, h / 2)
      .rotateSelf(model.rotate)
      .translateSelf(-w / 2, -h / 2)
  );
  drawChart(
    ctx,
    { h, w, x: 0, y: 0 },
    model,
    (color) => renderer.getColorValue(color, 'transparent', true),
    cardPaper(renderer.getColorScheme())
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
