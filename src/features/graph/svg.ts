/* The SVG export: the Canvas 2D calls `drawGraph` makes, replayed into SVG
 * made only of the tags `validGraphSvg` admits (no <image>, <foreignObject>,
 * <use> or data: addresses). Coordinates are rounded to 0.1 px and straight
 * runs thinned. A formula's stretched shapes (drawImage) are left out until
 * formulas export as glyph outlines (plan step 3). */
import type { DrawContext } from './draw';
import { drawGraph } from './draw';
import type { SizedGraph, Vec } from './model';
import { EXPORT_PAPER } from './paper';
import { viewOf } from './view';

/** A text's width in pixels in a CSS font. */
export type Measure = (font: string, text: string) => number;

type State = {
  alpha: number;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  cap: CanvasLineCap;
  dash: number[];
  fill: string;
  font: string;
  join: CanvasLineJoin;
  /** Clip groups opened since this state was saved. */
  opened: number;
  stroke: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  width: number;
};

const FONT =
  /^(?:(italic|oblique|normal)\s+)?(?:(normal|bold|\d{3})\s+)?([\d.]+)px\s+(.+)$/;
const ANCHOR: Partial<Record<CanvasTextAlign, string>> = {
  center: 'middle',
  end: 'end',
  right: 'end',
};
const BASELINE: Partial<Record<CanvasTextBaseline, string>> = {
  bottom: 'text-after-edge',
  middle: 'central',
  top: 'text-before-edge',
};

/** A coordinate at 0.1 px. */
const num = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};
const escapeXml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const finite = (...values: number[]) => values.every(Number.isFinite);
const attrs = (pairs: [string, string | number | undefined][]) =>
  pairs
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        ` ${key}="${typeof value === 'number' ? num(value) : escapeXml(value as string)}"`
    )
    .join('');

/** Records drawing as SVG; `toString` gives the document. */
export class SvgRecorder implements DrawContext {
  private readonly body: string[] = [];
  private readonly defs: string[] = [];
  private readonly saved: State[] = [];
  private state: State = {
    align: 'start',
    alpha: 1,
    baseline: 'alphabetic',
    cap: 'butt',
    dash: [],
    fill: '#000',
    font: '10px sans-serif',
    join: 'miter',
    opened: 0,
    stroke: '#000',
    sx: 1,
    sy: 1,
    tx: 0,
    ty: 0,
    width: 1,
  };
  /** The path being built: emitted commands, then the straight run after them. */
  private path: string[] = [];
  private run: Vec[] = [];
  private current: Vec | null = null;
  private start: Vec | null = null;
  /** Where the last emitted command ended, rounded as written. */
  private anchor: Vec | null = null;
  /** A haloed text's stroke, merged with the fill drawn over it. */
  private halo: { text: string; x: number; y: number; markup: string } | null =
    null;
  private clips = 0;
  filter = 'none';

  private readonly width: number;
  private readonly height: number;
  private readonly measure: Measure;
  /** Before each clip's id, so several recordings can share one document. */
  private readonly ids: string;

  constructor(width: number, height: number, measure: Measure, ids = '') {
    this.width = width;
    this.height = height;
    this.measure = measure;
    this.ids = ids;
  }

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.state.fill;
  }
  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this.state.fill = String(value);
  }
  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.state.stroke;
  }
  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    this.state.stroke = String(value);
  }
  get lineWidth() {
    return this.state.width;
  }
  set lineWidth(value: number) {
    this.state.width = value;
  }
  get lineCap() {
    return this.state.cap;
  }
  set lineCap(value: CanvasLineCap) {
    this.state.cap = value;
  }
  get lineJoin() {
    return this.state.join;
  }
  set lineJoin(value: CanvasLineJoin) {
    this.state.join = value;
  }
  get globalAlpha() {
    return this.state.alpha;
  }
  set globalAlpha(value: number) {
    this.state.alpha = value;
  }
  get font() {
    return this.state.font;
  }
  set font(value: string) {
    this.state.font = value;
  }
  get textAlign() {
    return this.state.align;
  }
  set textAlign(value: CanvasTextAlign) {
    this.state.align = value;
  }
  get textBaseline() {
    return this.state.baseline;
  }
  set textBaseline(value: CanvasTextBaseline) {
    this.state.baseline = value;
  }

  save() {
    this.saved.push(this.state);
    this.state = { ...this.state, dash: [...this.state.dash], opened: 0 };
  }
  restore() {
    const previous = this.saved.pop();
    if (!previous) return;
    this.flushHalo();
    for (let i = 0; i < this.state.opened; i++) this.body.push('</g>');
    this.state = previous;
  }
  translate(x: number, y: number) {
    this.state.tx += this.state.sx * x;
    this.state.ty += this.state.sy * y;
  }
  scale(x: number, y: number) {
    this.state.sx *= x;
    this.state.sy *= y;
  }
  setLineDash(segments: number[]) {
    this.state.dash = [...segments];
  }
  measureText(text: string) {
    return { width: this.measure(this.state.font, text) } as TextMetrics;
  }

  private device(x: number, y: number): Vec {
    return [
      this.state.sx * x + this.state.tx,
      this.state.sy * y + this.state.ty,
    ];
  }

  beginPath() {
    this.path = [];
    this.run = [];
    this.current = null;
    this.start = null;
    this.anchor = null;
  }
  moveTo(x: number, y: number) {
    const point = this.device(x, y);
    if (!finite(...point)) {
      this.flushRun();
      this.current = null;
      return;
    }
    this.flushRun();
    this.push(`M${num(point[0])} ${num(point[1])}`, point);
    this.current = point;
    this.start = point;
  }
  private push(command: string, end: Vec | null) {
    this.path.push(command);
    this.anchor = end && [Number(num(end[0])), Number(num(end[1]))];
  }
  lineTo(x: number, y: number) {
    if (!this.current) {
      this.moveTo(x, y);
      return;
    }
    const point = this.device(x, y);
    if (!finite(...point)) {
      this.flushRun();
      this.current = null;
      return;
    }
    this.run.push(point);
    this.current = point;
  }
  bezierCurveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x: number,
    y: number
  ) {
    if (!this.current) this.moveTo(x1, y1);
    const points = [
      this.device(x1, y1),
      this.device(x2, y2),
      this.device(x, y),
    ];
    if (!finite(...points.flat())) return;
    this.flushRun();
    this.push(
      `C${points.map(([px, py]) => `${num(px)} ${num(py)}`).join(' ')}`,
      points[2]
    );
    this.current = points[2];
  }
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false
  ) {
    this.ellipse(
      x,
      y,
      radius,
      radius,
      0,
      startAngle,
      endAngle,
      counterclockwise
    );
  }
  /** Upright ellipses only: the engine draws no turned one. */
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    _rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false
  ) {
    const [cx, cy] = this.device(x, y);
    const rx = Math.abs(radiusX * this.state.sx);
    const ry = Math.abs(radiusY * this.state.sy);
    if (!finite(cx, cy, rx, ry, startAngle, endAngle)) return;
    const turn = Math.PI * 2;
    let sweep = endAngle - startAngle;
    const full = counterclockwise ? -sweep >= turn : sweep >= turn;
    if (full) sweep = counterclockwise ? -turn : turn;
    else if (counterclockwise) sweep = -(((-sweep % turn) + turn) % turn);
    else sweep = ((sweep % turn) + turn) % turn;
    const at = (angle: number): Vec => [
      cx + rx * Math.cos(angle),
      cy + ry * Math.sin(angle),
    ];
    const from = at(startAngle);
    if (this.current) this.lineToDevice(from);
    else {
      this.flushRun();
      this.push(`M${num(from[0])} ${num(from[1])}`, from);
      this.start = from;
    }
    this.flushRun();
    const flag = sweep > 0 ? 1 : 0;
    const radii = `${num(rx)} ${num(ry)} 0`;
    if (full) {
      const half = at(startAngle + sweep / 2);
      this.push(
        `A${radii} 0 ${flag} ${num(half[0])} ${num(half[1])}A${radii} 0 ${flag} ${num(from[0])} ${num(from[1])}`,
        from
      );
      this.current = from;
      return;
    }
    const to = at(startAngle + sweep);
    this.push(
      `A${radii} ${Math.abs(sweep) > Math.PI ? 1 : 0} ${flag} ${num(to[0])} ${num(to[1])}`,
      to
    );
    this.current = to;
  }
  private lineToDevice(point: Vec) {
    this.run.push(point);
    this.current = point;
  }
  rect(x: number, y: number, w: number, h: number) {
    this.flushRun();
    const [left, top] = this.device(x, y);
    const [right, bottom] = this.device(x + w, y + h);
    if (!finite(left, top, right, bottom)) return;
    this.push(
      `M${num(left)} ${num(top)}H${num(right)}V${num(bottom)}H${num(left)}Z`,
      [left, top]
    );
    this.current = [left, top];
    this.start = [left, top];
  }
  closePath() {
    if (!this.current) return;
    this.flushRun();
    this.push('Z', this.start);
    this.current = this.start;
  }

  /** The straight run after the last command, rounded, repeats and points on a
   * straight stretch dropped. */
  private flushRun() {
    if (!this.run.length) return;
    const kept: Vec[] = [];
    const anchor = this.anchor;
    for (const point of this.run) {
      const p: Vec = [Number(num(point[0])), Number(num(point[1]))];
      const previous = kept.at(-1) ?? anchor;
      if (previous && previous[0] === p[0] && previous[1] === p[1]) continue;
      const before = kept.length > 1 ? kept.at(-2) : anchor;
      if (previous && before && kept.length && onSegment(before, previous, p))
        kept[kept.length - 1] = p;
      else kept.push(p);
    }
    this.run = [];
    if (kept.length)
      this.push(
        `L${kept.map(([x, y]) => `${num(x)} ${num(y)}`).join(' ')}`,
        kept.at(-1) ?? null
      );
  }
  private pathData() {
    this.flushRun();
    return this.path.join('');
  }

  fill() {
    const d = this.pathData();
    if (!d) return;
    this.emit(
      `<path${attrs([
        ['d', d],
        ['fill', this.state.fill],
        [
          'fill-opacity',
          this.state.alpha === 1 ? undefined : String(this.state.alpha),
        ],
      ])}/>`
    );
  }
  stroke() {
    const d = this.pathData();
    if (!d) return;
    this.emit(
      `<path${attrs([['d', d], ['fill', 'none'], ...this.strokeAttrs()])}/>`
    );
  }
  private strokeAttrs(): [string, string | number | undefined][] {
    const { alpha, cap, dash, join, stroke, sx, width } = this.state;
    return [
      ['stroke', stroke],
      ['stroke-width', width * sx],
      ['stroke-linecap', cap === 'butt' ? undefined : cap],
      ['stroke-linejoin', join === 'miter' ? undefined : join],
      [
        'stroke-dasharray',
        dash.length ? dash.map((n) => num(n * sx)).join(' ') : undefined,
      ],
      ['stroke-opacity', alpha === 1 ? undefined : String(alpha)],
    ];
  }
  clip() {
    const d = this.pathData();
    this.clips++;
    const id = `${this.ids}clip${this.clips}`;
    this.flushHalo();
    this.defs.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
    this.body.push(`<g clip-path="url(#${id})">`);
    this.state.opened++;
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const [left, top] = this.device(x, y);
    if (!finite(left, top, w, h)) return;
    this.emit(
      `<rect${attrs([
        ['x', left],
        ['y', top],
        ['width', w * this.state.sx],
        ['height', h * this.state.sy],
        ['fill', this.state.fill],
        [
          'fill-opacity',
          this.state.alpha === 1 ? undefined : String(this.state.alpha),
        ],
      ])}/>`
    );
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    const [left, top] = this.device(x, y);
    if (!finite(left, top, w, h)) return;
    this.emit(
      `<rect${attrs([
        ['x', left],
        ['y', top],
        ['width', w * this.state.sx],
        ['height', h * this.state.sy],
        ['fill', 'none'],
        ...this.strokeAttrs(),
      ])}/>`
    );
  }
  /** Pictures are left out: an exported SVG holds no <image>. */
  drawImage() {
    // A formula's stretched shapes wait for the glyph-outline export.
  }

  private textAttrs(
    x: number,
    y: number
  ): [string, string | number | undefined][] {
    const [px, py] = this.device(x, y);
    const match = FONT.exec(this.state.font.trim());
    const size = match ? Number(match[3]) * this.state.sy : undefined;
    return [
      ['x', px],
      ['y', py],
      ['font-family', match ? match[4].replace(/"/g, "'") : this.state.font],
      ['font-size', size],
      [
        'font-style',
        match?.[1] && match[1] !== 'normal' ? match[1] : undefined,
      ],
      [
        'font-weight',
        match?.[2] && match[2] !== 'normal' && match[2] !== '400'
          ? match[2]
          : undefined,
      ],
      ['text-anchor', ANCHOR[this.state.align]],
      ['dominant-baseline', BASELINE[this.state.baseline]],
    ];
  }
  strokeText(text: string, x: number, y: number) {
    if (!finite(...this.device(x, y))) return;
    this.flushHalo();
    const { stroke, width, sx, join } = this.state;
    this.halo = {
      markup: attrs([
        ...this.textAttrs(x, y),
        ['stroke', stroke],
        ['stroke-width', width * sx],
        ['stroke-linejoin', join === 'miter' ? undefined : join],
      ]),
      text,
      x,
      y,
    };
  }
  fillText(text: string, x: number, y: number) {
    if (!finite(...this.device(x, y))) return;
    const halo = this.halo;
    this.halo = null;
    const fill = attrs([
      ['fill', this.state.fill],
      [
        'opacity',
        this.state.alpha === 1 ? undefined : String(this.state.alpha),
      ],
    ]);
    if (halo && halo.text === text && halo.x === x && halo.y === y) {
      this.body.push(
        `<text${halo.markup}${fill} paint-order="stroke">${escapeXml(text)}</text>`
      );
      return;
    }
    if (halo) this.pushHalo(halo);
    this.body.push(
      `<text${attrs(this.textAttrs(x, y))}${fill}>${escapeXml(text)}</text>`
    );
  }
  private pushHalo(halo: NonNullable<SvgRecorder['halo']>) {
    this.body.push(
      `<text${halo.markup} fill="none">${escapeXml(halo.text)}</text>`
    );
  }
  private flushHalo() {
    if (this.halo) this.pushHalo(this.halo);
    this.halo = null;
  }
  private emit(markup: string) {
    this.flushHalo();
    this.body.push(markup);
  }

  private content() {
    this.flushHalo();
    const open = [this.state, ...this.saved].reduce((n, s) => n + s.opened, 0);
    const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
    return `${defs}${this.body.join('')}${'</g>'.repeat(open)}`;
  }

  toString() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">${this.content()}</svg>`;
  }

  /** The drawing as an element of another SVG, filling `w` × `h` there at
   * (x, y) in that SVG's units. It sets the stroke ends the recording leaves at
   * SVG's defaults, which the SVG around it may have changed. */
  nested(x: number, y: number, w: number, h: number) {
    return `<svg${attrs([
      ['x', x],
      ['y', y],
      ['width', w],
      ['height', h],
    ])} viewBox="0 0 ${num(this.width)} ${num(this.height)}" overflow="hidden" stroke-linecap="butt" stroke-linejoin="miter">${this.content()}</svg>`;
  }
}

/** Whether `middle` sits on the straight stretch from `from` to `to`, within a
 * twentieth of a pixel, and between them. */
function onSegment(from: Vec, middle: Vec, to: Vec) {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const length = Math.hypot(dx, dy);
  if (!length) return false;
  const off =
    Math.abs((middle[0] - from[0]) * dy - (middle[1] - from[1]) * dx) / length;
  const along = (middle[0] - from[0]) * dx + (middle[1] - from[1]) * dy;
  return off <= 0.05 && along > 0 && along < length * length;
}

let measurer: CanvasRenderingContext2D | null = null;
/** Text widths from a canvas, made once: `graphSvg` runs in a browser. */
export const canvasMeasure: Measure = (font, text) => {
  measurer ??= document.createElement('canvas').getContext('2d');
  if (!measurer) throw new Error('No canvas to measure graph text');
  measurer.font = font;
  return measurer.measureText(text).width;
};

/** A graph's SVG at its size and stored view, on the light export paper. */
export function graphSvg(graph: SizedGraph, measure: Measure = canvasMeasure) {
  const { width, height } = graph;
  const recorder = new SvgRecorder(width, height, measure);
  drawGraph(
    recorder,
    { h: height, w: width, x: 0, y: 0 },
    viewOf(graph.board.bbox, width, height),
    graph,
    EXPORT_PAPER
  );
  return recorder.toString();
}
