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
  observe,
} from '@blocksuite/affine/std/gfx';
import * as Y from 'yjs';
import {
  type ElementEntry,
  type Keyed,
  keyedElements,
  readElements,
  writeElements,
} from '@/features/graph/keyed';
import type { Frame } from '@/features/graph/model';
import {
  AXIS_MAX,
  BAR_SHARE,
  barPlot,
  CARD_PADS,
  CHART_TEXT,
  type ChartBar,
  type ChartData,
  type ChartKind,
  cardPaper,
  filledSlices,
  LABELS_MAX,
  onScreen,
  type Paper,
  type PieLabel,
  type PieSpoke,
  pieCircle,
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
    for (const { fill, from, to } of filledSlices(chart.spokes)) {
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
    for (const { angle } of chart.spokes) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(...onScreen(cx, cy, r, angle));
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

/** A chart's lists, each stored as the plane's elements are (Epo 2026-11-22): one
 * entry per item id, the item and its order key, so changes to different bars,
 * labels or lines merge (D10). A pie line's entry carries its slice's fill. */
const LISTS = ['bars', 'labels', 'spokes'] as const;
type ListKey = (typeof LISTS)[number];
type Lists = Pick<ChartData, ListKey>;
type Entries<E extends Keyed> = Y.Map<ElementEntry<E>>;

/** What one write changes: lists in full, as they should read, and the axis. */
export type ChartChange = Partial<
  Lists & Pick<ChartData, 'axisMax' | 'axisStep'>
>;

/** A change inside a list reaches no field, so the chart says so itself: the
 * renderer and an open editor draw again. */
const observeList =
  (key: ListKey) =>
  (
    event: Y.YEvent<Y.Map<unknown>> | null,
    chart: ChartElementModel,
    transaction: Y.Transaction | null
  ) => {
    chart.forgetList(key);
    if (!(event && transaction)) return;
    chart.surface.elementUpdated.next({
      id: chart.id,
      local: transaction.local,
      oldValues: {},
      props: { [key]: chart[key] },
    });
  };

export class ChartElementModel extends GfxPrimitiveElementModel<{
  axisMax: number;
  axisStep: number;
  bars: Entries<ChartBar>;
  index: string;
  kind: ChartKind;
  labels: Entries<PieLabel>;
  rotate: number;
  seed: number;
  spokes: Entries<PieSpoke>;
  xywh: SerializedXYWH;
}> {
  get type() {
    return 'chart';
  }

  /** A pasted or new card's lists, plain (`keyedElements`) or as the clipboard
   * serialized them, become the stored maps, as the plane's elements do. */
  static propsToY(props: Record<string, unknown>) {
    for (const key of LISTS) {
      const value = props[key];
      if (!value || value instanceof Y.Map) continue;
      const entries = new Y.Map<unknown>();
      for (const [id, entry] of Object.entries(
        value as Record<string, unknown>
      ))
        entries.set(id, entry);
      props[key] = entries;
    }
    return props;
  }

  /** Each list in order, read once per change to its map. */
  readonly #lists: Partial<Lists> = {};
  get barList() {
    this.#lists.bars ??= readElements(this.bars.entries());
    return this.#lists.bars;
  }
  get labelList() {
    this.#lists.labels ??= readElements(this.labels.entries());
    return this.#lists.labels;
  }
  get spokeList() {
    this.#lists.spokes ??= readElements(this.spokes.entries());
    return this.#lists.spokes;
  }
  forgetList(key: ListKey) {
    delete this.#lists[key];
  }
  /** The chart as it's drawn. */
  get data(): ChartData {
    const { axisMax, axisStep, kind } = this;
    return {
      axisMax,
      axisStep,
      bars: this.barList,
      kind,
      labels: this.labelList,
      spokes: this.spokeList,
    };
  }
  /** Makes the chart hold `change` in one transaction, one undo step: each list
   * given writes only its items that changed. */
  write(change: ChartChange) {
    const { axisMax, axisStep, bars, labels, spokes } = change;
    this.surface.store.transact(() => {
      if (bars) writeElements(this.bars, bars);
      if (labels) writeElements(this.labels, labels);
      if (spokes) writeElements(this.spokes, spokes);
      if (axisMax !== undefined) this.axisMax = axisMax;
      if (axisStep !== undefined) this.axisStep = axisStep;
    });
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

  @observe(observeList('bars'))
  @field()
  accessor bars: Entries<ChartBar> = new Y.Map();

  @field()
  accessor kind: ChartKind = 'bar';

  @observe(observeList('labels'))
  @field()
  accessor labels: Entries<PieLabel> = new Y.Map();

  @field(0)
  accessor rotate = 0;

  @observe(observeList('spokes'))
  @field()
  accessor spokes: Entries<PieSpoke> = new Y.Map();

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
    model.data,
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

/** A pie's first line, at 12 o'clock, as a new one starts and Clear all leaves it.
 * Its id is the same on every pie, so two Clear alls at once, or one crossing a
 * peer's turn or fill of that line, leave one line (Epo 2026-11-22). */
export const FIRST_SPOKE = 'first';
export const firstSpokes = (kind: ChartKind): PieSpoke[] =>
  kind === 'pie' ? [{ angle: 0, id: FIRST_SPOKE }] : [];

/** Clear all: no bars or labels, and a pie back to its first line. */
export const cleared = (kind: ChartKind): ChartChange => ({
  bars: [],
  labels: [],
  spokes: firstSpokes(kind),
});

/** `list` with `item` added at the end, or null at `max` or past it. An add checks
 * the list as it reads when written, so a bar a peer added mid-drag counts; only adds
 * merged from the same moment pass the cap, which the load check takes up to twice. */
export const appended = <T>(list: T[], item: T, max: number) =>
  list.length < max ? [...list, item] : null;

/** Where a pie label's text field opened, on a label (its id) or at a new place, and
 * the text it opened with. */
export type LabelDraft = Pick<PieLabel, 'angle' | 'reach' | 'text'> & {
  id?: string;
};

/** The pie labels once a text field closes, or null for no change. Only text changed
 * from what the field opened with is written, so closing an untouched field keeps a
 * peer's rename. An existing label takes only the text, onto it as it reads now, so a
 * peer's move or resize stays and a label a peer erased stays erased; no text removes
 * it. A new label goes where the field opened, under the cap. */
export function typedLabels(
  labels: PieLabel[],
  { angle, id, reach, text: opened }: LabelDraft,
  text: string
): PieLabel[] | null {
  if (text === opened) return null;
  if (!id)
    return appended(
      labels,
      { angle, id: crypto.randomUUID(), reach, text },
      LABELS_MAX
    );
  if (!labels.some((one) => one.id === id)) return null;
  return text
    ? labels.map((one) => (one.id === id ? { ...one, text } : one))
    : labels.filter((one) => one.id !== id);
}

/** The bars once the label field of bar `id` closes, or null for no change: only text
 * changed from what the field `opened` with is written, onto the bar as it reads now. */
export function typedBars(
  bars: ChartBar[],
  id: string,
  opened: string,
  text: string
): ChartBar[] | null {
  if (text === opened || !bars.some((bar) => bar.id === id)) return null;
  return bars.map((bar) => (bar.id === id ? { ...bar, label: text } : bar));
}

/** Most numbered lines a chart's axis takes. */
export const AXIS_LINES_MAX = 100;
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** An axis to a top, about five numbered lines in 1, 2, 2.5 or 5 steps, its top
 * never past AXIS_MAX. */
export function niceAxis(top: number) {
  const rough = top / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const axisStep =
    (NICE_STEPS.find((step) => step * power >= rough) ?? 10) * power;
  return {
    axisMax: Math.min(
      AXIS_MAX,
      Number((Math.ceil(top / axisStep - 1e-9) * axisStep).toPrecision(12))
    ),
    axisStep: Number(axisStep.toPrecision(12)),
  };
}

/** The axis that shows `top`: the first line of `axisStep` at or above it, or a
 * nice axis to it where that line would be past AXIS_MAX (which the board's rules refuse)
 * or past AXIS_LINES_MAX lines. */
export function axisAbove(top: number, axisStep: number) {
  const axisMax = Number(
    (Math.max(Math.ceil(top / axisStep - 1e-9), 1) * axisStep).toPrecision(12)
  );
  return axisMax <= AXIS_MAX && axisMax / axisStep <= AXIS_LINES_MAX
    ? { axisMax, axisStep }
    : niceAxis(top);
}

/** The bars once a drag lifts, against the chart as it read `before` it: a bar the
 * drag took to 0 goes. One at 0 before stays (typed as 0 in the data pane), held
 * along at 0 or moved up and back down to 0. */
export function liftedBars(before: ChartBar[], after: ChartBar[]) {
  const was = new Map(before.map(({ id, value }) => [id, value]));
  return after.filter(({ id, value }) => value || was.get(id) === 0);
}

export function addChart(gfx: GfxController, box: Bound, kind: ChartKind) {
  return gfx.surface?.addElement({
    axisMax: 10,
    axisStep: 2,
    bars: keyedElements<ChartBar>([]),
    kind,
    labels: keyedElements<PieLabel>([]),
    spokes: keyedElements(firstSpokes(kind)),
    type: 'chart',
    xywh: box.serialize(),
  });
}
