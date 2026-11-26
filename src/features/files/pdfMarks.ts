import type { PDFAnnotation, PDFPoint, PDFRect } from '@/api/types';

/* Private PDF marks (Epo 2026-11-24, mock "PDF annotation round 1"). A mark
   sits in page units on the page as shown, its longer side 1000 on both axes,
   so ink, text and circles keep their shape at any zoom. A page's rotation is
   part of the bytes its marks are saved on (sourceIdentity), so the page as
   shown is the page. */

export type Mark = PDFAnnotation;
export type MarkKind = Mark['kind'];
export type Point = PDFPoint;
export type Box = PDFRect;

export const PAGE_UNITS = 1000;
/** The highlighter's yellow first; keys 1 to 6 pick them. */
export const MARK_COLORS = [
  '#dfa626',
  '#d94848',
  '#2d9161',
  '#287bb8',
  '#7c5cc4',
  '#333333',
] as const;
export type Weight = 's' | 'm' | 'l';
export const WEIGHTS: Weight[] = ['s', 'm', 'l'];
const PEN_WIDTHS: Record<Weight, number> = { l: 5.5, m: 3, s: 1.75 };
/** A marker is a highlighter's band, five pens wide. */
const MARKER_SCALE = 5;
export const TEXT_SIZES: Record<Weight, number> = { l: 21, m: 15, s: 11 };
/** A note's pin, square. */
export const NOTE_SIZE = 24;
/** A text box's width when placed, and its least. */
export const TEXT_WIDTH = 160;
const MIN_TEXT_WIDTH = 24;
/** One mark's points across its strokes: the server's cap. */
export const MAX_POINTS = 4096;
/** A pen stroke joins the last pen mark drawn this soon after, this near. */
export const GROUP_MS = 1000;
export const GROUP_REACH = 42;
/** The eraser's radius in CSS pixels. */
export const ERASER_PX = 16;

export const isStroked = (kind: MarkKind) =>
  kind === 'pen' ||
  kind === 'marker' ||
  kind === 'rectangle' ||
  kind === 'ellipse' ||
  kind === 'arrow';
/** Bands on the text: they keep their place (D1). */
export const onText = (kind: MarkKind) =>
  kind === 'highlight' || kind === 'underline';
export const strokeWidth = (kind: MarkKind, weight: Weight) =>
  kind === 'marker' ? PEN_WIDTHS[weight] * MARKER_SCALE : PEN_WIDTHS[weight];
export const markWeight = (mark: Mark): Weight | undefined =>
  WEIGHTS.find((weight) =>
    mark.kind === 'text'
      ? TEXT_SIZES[weight] === mark.size
      : strokeWidth(mark.kind, weight) === mark.width
  );

/** Marks by ID after a change; null is a removed mark. */
export type MarkChange = Map<string, Mark | null>;

export function applyChange(
  marks: readonly Mark[],
  change: MarkChange
): Mark[] {
  if (!change.size) return marks as Mark[];
  const next = marks
    .filter((mark) => change.get(mark.id) !== null)
    .map((mark) => change.get(mark.id) ?? mark);
  for (const [id, mark] of change)
    if (mark && !marks.some((row) => row.id === id)) next.push(mark);
  return next;
}

export function newMarkId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `ann_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
/** Two decimals: a hundredth of a unit is under a hundredth of a pixel. */
const round = (value: number) => Math.round(value * 100) / 100;
export const roundPoint = (p: Point): Point => ({
  x: round(p.x),
  y: round(p.y),
});

/** Where a page sits on screen and its size in units. */
export type PageFrame = {
  left: number;
  top: number;
  /** Units per CSS pixel. */
  scale: number;
  width: number;
  height: number;
};

export function pageFrame(page: Element): PageFrame {
  const { left, top, width, height } = page.getBoundingClientRect();
  const scale = PAGE_UNITS / Math.max(width, height, 1);
  // The longer side is PAGE_UNITS exactly, never a float's hair over the
  // server's bound.
  return {
    height: height >= width ? PAGE_UNITS : height * scale,
    left,
    scale,
    top,
    width: width >= height ? PAGE_UNITS : width * scale,
  };
}

const atUnit = (value: number) => round(clamp(value, 0, PAGE_UNITS));
/** A start and size on the hundredth, inside the bound, at least a hundredth. */
function span(start: number, size: number): [number, number] {
  const from = Math.min(atUnit(start), PAGE_UNITS - 0.01);
  return [from, round(Math.max(atUnit(start + size), from + 0.01) - from)];
}

/** A mark as the server takes it: every corner and point on the hundredth and
 * inside the page bound. Every saved change passes through it (usePdfMarks). */
export function normalizeMark(mark: Mark): Mark {
  return {
    ...mark,
    rects: mark.rects.map((r) => {
      const [x, width] = span(r.x, r.width);
      const [y, height] = span(r.y, r.height);
      return { height, width, x, y };
    }),
    strokes: mark.strokes.map((stroke) =>
      stroke.map((p) => ({ x: atUnit(p.x), y: atUnit(p.y) }))
    ),
  };
}

export const toPage = (frame: PageFrame, x: number, y: number): Point => ({
  x: clamp((x - frame.left) * frame.scale, 0, frame.width),
  y: clamp((y - frame.top) * frame.scale, 0, frame.height),
});

export const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length
    ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length, 0, 1)
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function polylineDistance(p: Point, points: readonly Point[]) {
  let best = points.length ? distance(p, points[0]) : Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++)
    best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
  return best;
}

/** A mark's own extent: its rects and stroke points, without its ink. */
function extent(mark: Mark): Box {
  let x1 = Number.POSITIVE_INFINITY,
    y1 = Number.POSITIVE_INFINITY,
    x2 = Number.NEGATIVE_INFINITY,
    y2 = Number.NEGATIVE_INFINITY;
  for (const r of mark.rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  for (const stroke of mark.strokes)
    for (const p of stroke) {
      x1 = Math.min(x1, p.x);
      y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x);
      y2 = Math.max(y2, p.y);
    }
  return { height: y2 - y1, width: x2 - x1, x: x1, y: y1 };
}

const arrowHead = (width: number) => 7 + width * 2.2;

/** The box a mark's ink covers: its frame when selected. */
export function markBox(mark: Mark): Box {
  const box = extent(mark);
  const pad = isStroked(mark.kind)
    ? mark.width / 2 +
      (mark.kind === 'arrow' ? arrowHead(mark.width) * 0.45 : 0)
    : 0;
  return {
    height: box.height + pad * 2,
    width: box.width + pad * 2,
    x: box.x - pad,
    y: box.y - pad,
  };
}

export const unionBox = (boxes: readonly Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    x,
    y,
  };
};

const overlaps = (a: Box, b: Box, pad: number) =>
  a.x - pad <= b.x + b.width &&
  b.x <= a.x + a.width + pad &&
  a.y - pad <= b.y + b.height &&
  b.y <= a.y + a.height + pad;

const inside = (p: Point, r: Box, pad: number) =>
  p.x >= r.x - pad &&
  p.x <= r.x + r.width + pad &&
  p.y >= r.y - pad &&
  p.y <= r.y + r.height + pad;

/** On the ink, not its box (D1): a shape is hit on its outline, so the text
 * inside it stays selectable. */
export function hitMark(mark: Mark, p: Point, tolerance: number): boolean {
  const reach = mark.width / 2 + tolerance;
  switch (mark.kind) {
    case 'pen':
    case 'marker':
    case 'arrow':
      return mark.strokes.some(
        (stroke) => polylineDistance(p, stroke) <= reach
      );
    case 'highlight':
    case 'underline':
      return mark.rects.some((r) => inside(p, r, 1));
    case 'rectangle': {
      const r = mark.rects[0];
      const nearX =
        Math.abs(p.x - r.x) <= reach || Math.abs(p.x - r.x - r.width) <= reach;
      const nearY =
        Math.abs(p.y - r.y) <= reach || Math.abs(p.y - r.y - r.height) <= reach;
      return (
        (nearX && p.y >= r.y - reach && p.y <= r.y + r.height + reach) ||
        (nearY && p.x >= r.x - reach && p.x <= r.x + r.width + reach)
      );
    }
    case 'ellipse': {
      const r = mark.rects[0];
      const rx = r.width / 2,
        ry = r.height / 2;
      if (rx < 0.5 || ry < 0.5) return inside(p, r, reach);
      const v = Math.hypot((p.x - r.x - rx) / rx, (p.y - r.y - ry) / ry);
      return Math.abs(v - 1) * Math.min(rx, ry) <= reach;
    }
    case 'text':
    case 'note':
      return inside(p, mark.rects[0], tolerance / 2);
  }
}

/** The topmost mark under the point: the last drawn. */
export function topHit(marks: readonly Mark[], p: Point, tolerance: number) {
  for (let i = marks.length - 1; i >= 0; i--)
    if (hitMark(marks[i], p, tolerance)) return marks[i];
}

export const moveMark = (mark: Mark, dx: number, dy: number): Mark => ({
  ...mark,
  rects: mark.rects.map((r) => ({
    ...r,
    x: round(r.x + dx),
    y: round(r.y + dy),
  })),
  strokes: mark.strokes.map((stroke) =>
    stroke.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) }))
  ),
});

/** The part of a shift that keeps every mark on its page. */
export function clampShift(
  marks: readonly Mark[],
  dx: number,
  dy: number,
  page: { width: number; height: number }
): [number, number] {
  if (!marks.length) return [0, 0];
  const box = unionBox(marks.map(extent));
  return [
    clamp(dx, -box.x, page.width - box.x - box.width),
    clamp(dy, -box.y, page.height - box.y - box.height),
  ];
}

export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'e';

/** The handles a lone selected mark shows: a text box's width, a shape's
 * corners; bands on the text and notes keep their size. */
export function markHandles(mark: Mark): Handle[] {
  if (mark.kind === 'text') return ['e'];
  if (onText(mark.kind) || mark.kind === 'note') return [];
  return ['nw', 'ne', 'sw', 'se'];
}

/** A handle pulled to p: ink scales evenly and keeps its shape (PDF.js), a
 * shape or arrow stretches, a text box takes a new width. The handle sits on
 * the mark's frame (markBox), so the frame's corner follows the pointer. */
export function resizeMark(
  orig: Mark,
  handle: Handle,
  p: Point,
  page: { width: number; height: number }
): Mark {
  if (handle === 'e') {
    const r = orig.rects[0];
    return {
      ...orig,
      rects: [
        {
          ...r,
          width: round(clamp(p.x - r.x, MIN_TEXT_WIDTH, page.width - r.x)),
        },
      ],
    };
  }
  const e = extent(orig);
  // markBox pads evenly: the frame's corner is the extent's, this far out.
  const pad = e.x - markBox(orig).x;
  const west = handle.includes('w'),
    north = handle.includes('n');
  const ax = west ? e.x + e.width : e.x,
    ay = north ? e.y + e.height : e.y;
  const fx = west ? e.x : e.x + e.width,
    fy = north ? e.y : e.y + e.height;
  // Where the extent's far corner goes for the frame's corner to sit at p.
  const tx = clamp(p.x + (west ? pad : -pad), 0, page.width),
    ty = clamp(p.y + (north ? pad : -pad), 0, page.height);
  if (orig.kind === 'rectangle' || orig.kind === 'ellipse')
    return {
      ...orig,
      rects: [
        {
          height: Math.max(0.5, Math.abs(ty - ay)),
          width: Math.max(0.5, Math.abs(tx - ax)),
          x: Math.min(ax, tx),
          y: Math.min(ay, ty),
        },
      ],
    };
  const dx = fx - ax,
    dy = fy - ay;
  let sx: number, sy: number;
  if (orig.kind === 'arrow') {
    // A level or upright arrow has no span on one axis to stretch.
    sx = dx ? (tx - ax) / dx : 1;
    sy = dy ? (ty - ay) / dy : 1;
  } else {
    // Ink: the even scale that brings the far corner nearest the pointer, so
    // a level line still grows.
    const length = dx * dx + dy * dy;
    sx = length ? ((tx - ax) * dx + (ty - ay) * dy) / length : 1;
    sy = sx;
  }
  sx = Math.max(0.05, sx);
  sy = Math.max(0.05, sy);
  return {
    ...orig,
    strokes: orig.strokes.map((stroke) =>
      stroke.map((q) => ({
        x: clamp(ax + (q.x - ax) * sx, 0, page.width),
        y: clamp(ay + (q.y - ay) * sy, 0, page.height),
      }))
    ),
  };
}

/** Extra points along each segment near the eraser, so rubbing out the middle
 * of a long straight segment cuts it there. */
function densify(
  stroke: readonly Point[],
  near: (a: Point, b: Point) => boolean,
  step: number
) {
  const out: Point[] = [stroke[0]];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1],
      b = stroke[i];
    const n = near(a, b) ? Math.ceil(distance(a, b) / step) : 1;
    for (let k = 1; k <= n; k++)
      out.push({
        x: a.x + ((b.x - a.x) * k) / n,
        y: a.y + ((b.y - a.y) * k) / n,
      });
  }
  return out;
}

/** The eraser swept from a to b. Pen ink under it goes and its stroke splits
 * at the gap (D7, Zotero); any other mark it touches goes whole. Returns the
 * marks it changed: the cut pens, and null for each removed mark. */
export function eraseAlong(
  marks: readonly Mark[],
  a: Point,
  b: Point,
  radius: number
): Map<string, Mark | null> {
  const out = new Map<string, Mark | null>();
  const sweep = unionBox([
    { height: 0, width: 0, x: a.x, y: a.y },
    { height: 0, width: 0, x: b.x, y: b.y },
  ]);
  const samples = Math.max(1, Math.ceil(distance(a, b) / (radius / 2)));
  const along = Array.from({ length: samples + 1 }, (_, k) => ({
    x: a.x + ((b.x - a.x) * k) / samples,
    y: a.y + ((b.y - a.y) * k) / samples,
  }));
  for (const mark of marks) {
    const reach = radius + mark.width / 2;
    if (!overlaps(sweep, markBox(mark), reach)) continue;
    if (mark.kind === 'pen') {
      const touched = (q: Point) => segmentDistance(q, a, b) <= reach;
      const near = (p: Point, q: Point) =>
        overlaps(
          sweep,
          unionBox([
            { ...p, height: 0, width: 0 },
            { ...q, height: 0, width: 0 },
          ]),
          reach
        );
      const pieces: Point[][] = [];
      let cut = false;
      for (const stroke of mark.strokes) {
        let piece: Point[] = [];
        for (const q of densify(stroke, near, radius / 3)) {
          if (touched(q)) {
            cut = true;
            if (piece.length > 1) pieces.push(piece);
            piece = [];
          } else piece.push(q);
        }
        if (piece.length > 1) pieces.push(piece);
      }
      if (!cut) continue;
      const strokes = pieces.map((piece) =>
        simplify(piece, 0.2).map(roundPoint)
      );
      const points = strokes.reduce((n, stroke) => n + stroke.length, 0);
      if (!strokes.length) out.set(mark.id, null);
      else if (points <= MAX_POINTS && strokes.length <= 512)
        out.set(mark.id, { ...mark, strokes });
      continue;
    }
    if (along.some((q) => hitMark(mark, q, radius))) out.set(mark.id, null);
  }
  return out;
}

/** A marker stroke close to level snaps straight (EmbedPDF's ink highlighter). */
export function straighten(points: readonly Point[]): Point[] {
  const a = points[0],
    b = points.at(-1) as Point;
  const length = distance(a, b);
  if (points.length < 2 || length < 20) return [...points];
  const deviation = Math.max(...points.map((p) => segmentDistance(p, a, b)));
  const angle =
    Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 180;
  if (deviation >= length * 0.15 || Math.min(angle, 180 - angle) >= 15)
    return [...points];
  const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return [
    { x: a.x, y },
    { x: b.x, y },
  ];
}

/** Ramer–Douglas–Peucker: drops samples within tolerance of the line. */
export function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    let index = -1,
      far = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > far) {
        far = d;
        index = i;
      }
    }
    if (index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A curve through the samples' midpoints (PDF.js, T3 Code's drawing). */
export function smoothPath(points: readonly Point[]): string {
  if (!points.length) return '';
  const f = (v: number) => Math.round(v * 10) / 10;
  if (points.length === 1) return `M${f(points[0].x)} ${f(points[0].y)}h0.01`;
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1];
    d += `Q${f(a.x)} ${f(a.y)} ${f((a.x + b.x) / 2)} ${f((a.y + b.y) / 2)}`;
  }
  const last = points.at(-1) as Point;
  return `${d}L${f(last.x)} ${f(last.y)}`;
}

export function arrowPath(a: Point, b: Point, width: number): string {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = arrowHead(width);
  const wing = (turn: number) =>
    `${b.x - head * Math.cos(angle + turn)} ${b.y - head * Math.sin(angle + turn)}`;
  return `M${a.x} ${a.y}L${b.x} ${b.y}M${wing(-0.45)}L${b.x} ${b.y}L${wing(0.45)}`;
}

/** One band per line: pieces whose middles share a line merge, so overlaps
 * never darken (the browser gives a rect per text run). */
export function mergeLines(rects: readonly Box[]): Box[] {
  const lines: Box[] = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const middle = r.y + r.height / 2;
    const line = lines.find(
      (l) =>
        Math.abs(l.y + l.height / 2 - middle) < Math.min(l.height, r.height) / 2
    );
    if (!line) {
      lines.push({ ...r });
      continue;
    }
    const right = Math.max(line.x + line.width, r.x + r.width),
      bottom = Math.max(line.y + line.height, r.y + r.height);
    line.x = Math.min(line.x, r.x);
    line.y = Math.min(line.y, r.y);
    line.width = right - line.x;
    line.height = bottom - line.y;
  }
  return lines.map((l) => ({
    height: round(l.height),
    width: round(l.width),
    x: round(l.x),
    y: round(l.y),
  }));
}

export type TextBand = { page: number; rects: Box[]; text: string };

/** The selected PDF text as bands per page, with the text each covers. */
export function textSelectionBands(container: HTMLElement): TextBand[] {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return [];
  const pages = new Map<
    number,
    { frame: PageFrame; rects: Box[]; text: string[] }
  >();
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const page = node.parentElement
        ?.closest('.react-pdf__Page__textContent')
        ?.closest<HTMLElement>('[data-page]');
      if (!(page && range.intersectsNode(node))) continue;
      const part = document.createRange();
      part.selectNodeContents(node);
      if (range.startContainer === node) part.setStart(node, range.startOffset);
      if (range.endContainer === node) part.setEnd(node, range.endOffset);
      if (part.collapsed) continue;
      const number = Number(page.dataset.page);
      let entry = pages.get(number);
      if (!entry) {
        entry = { frame: pageFrame(page), rects: [], text: [] };
        pages.set(number, entry);
      }
      const { frame } = entry;
      for (const rect of part.getClientRects())
        if (rect.width > 0 && rect.height > 0) {
          const a = toPage(frame, rect.left, rect.top),
            b = toPage(frame, rect.right, rect.bottom);
          if (b.x - a.x > 0 && b.y - a.y > 0)
            entry.rects.push({
              height: b.y - a.y,
              width: b.x - a.x,
              x: a.x,
              y: a.y,
            });
        }
      entry.text.push(part.toString());
    }
  }
  return [...pages]
    .filter(([, entry]) => entry.rects.length)
    .map(([page, entry]) => ({
      page,
      rects: mergeLines(entry.rects).slice(0, 1000),
      text: entry.text.join('').replace(/\s+/g, ' ').trim().slice(0, 2000),
    }));
}
