import { drawGraph } from '@/features/graph/draw';
import {
  type ElementEntry,
  type Keyed,
  readElements,
} from '@/features/graph/keyed';
import type { GraphElement } from '@/features/graph/model';
import { EXPORT_PAPER } from '@/features/graph/paper';
import { canvasMeasure, SvgRecorder } from '@/features/graph/svg';
import { bboxOf, type View } from '@/features/graph/view';
import { m } from '@/i18n';
import { fromBase64 } from './base64';
import {
  BAR_SHARE,
  barPlot,
  CARD_PADS,
  type ChartBar,
  filledSlices,
  INK,
  onScreen,
  type PieSpoke,
  pieCircle,
} from './boardData';
import { AREA_PROP, areaBox, type Box, unite, type Vec } from './boardGeometry';
import { BoardLoadError, checkSavedBoard } from './boardLoad';
import { type BoardKind, type Fields, isPlace } from './boardRules';
import { decodeStrokePoints, type StrokePoint } from './strokePoints';

/** A saved board drawn from its data as an SVG string, for lists, results and marking
 * views, without the editor: what's on it, not every detail (Epo 2026-11-06). Framed as
 * the marking image is, on white: a question board's answer area exactly, what
 * crosses its edge cut there (Epo 2026-11-23); a workspace canvas everything.
 * Strokes are plain lines, connectors straight, formulas their LaTeX, notes a line per
 * paragraph, a placed quiz or set its title and kind, pasted images a grey box, plane
 * cards as the graph engine draws them (numbers included) without their labels and
 * formulas, and no labels on charts. Throws a BoardLoadError for a board that doesn't
 * check out. */
export function drawBoardPreview(
  saved: string,
  size: { height: number; width: number },
  board: BoardKind,
  /** Cropped to the drawing, at most `size`, instead of centred in it: an
   * inline preview then starts at its column's edge. */
  fit = false
) {
  let update: Uint8Array;
  try {
    update = fromBase64(saved);
  } catch (cause) {
    throw new BoardLoadError('unreadable', { cause });
  }
  const { blocks, elements } = checkSavedBoard(update, board);
  // Where each card, shape, note and image sits, for the connectors' ends. A group,
  // a connector and a mind map store no place (a mind map's nodes are its shapes).
  const placed = [
    ...Object.entries(elements).filter(
      ([, element]) => !UNPLACED.has(element.type as string)
    ),
    ...Object.entries(blocks).filter(
      ([id, block]) =>
        // A note kept for page mode only isn't on the canvas.
        (block['sys:flavour'] === 'affine:note' &&
          block['prop:displayMode'] !== 'doc') ||
        block['sys:flavour'] === MATERIAL_CARD ||
        (block['sys:flavour'] === 'affine:image' &&
          isOnCanvas(blocks, id) &&
          isPlace(block['prop:xywh']))
    ),
  ];
  const boxById = new Map(
    placed.map(([id, fields]) => [
      id,
      boxOf(fields.xywh ?? fields['prop:xywh']),
    ])
  );
  const items: Item[] = placed.map(([id, fields]) => ({
    box: boxById.get(id) as Box,
    fields,
    index: String(fields.index ?? fields['prop:index'] ?? ''),
    kind: String(fields.type ?? fields['sys:flavour']),
  }));
  // A connector sits where its ends are: BlockSuite never stores its place.
  for (const fields of Object.values(elements)) {
    if (fields.type !== 'connector') continue;
    const from = endPoint(fields.source, boxById);
    const to = endPoint(fields.target, boxById);
    if (!from || !to) continue;
    const box = unite([
      { h: 0, w: 0, x: from[0], y: from[1] },
      { h: 0, w: 0, x: to[0], y: to[1] },
    ]);
    items.push({
      box,
      ends: [from, to],
      fields,
      index: String(fields.index ?? ''),
      kind: 'connector',
    });
  }
  // As the board stacks them; at the same place in the stack, a note goes over.
  items.sort((a, b) =>
    a.index === b.index
      ? Number(a.kind === 'affine:note') - Number(b.kind === 'affine:note')
      : a.index < b.index
        ? -1
        : 1
  );

  const head = (width: number, height: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/>`;
  const page = Object.values(blocks).find(
    (block) => block['sys:flavour'] === 'affine:page'
  );
  const area = board === 'question' ? areaBox(page?.[AREA_PROP]) : null;
  const shown = area ? items.filter(({ box }) => overlaps(box, area)) : items;
  if (!shown.length) return `${head(size.width, size.height)}</svg>`;

  const all = unite(shown.map((item) => item.box));
  const frame = area ?? {
    h: all.h + 16,
    w: all.w + 16,
    x: all.x - 8,
    y: all.y - 8,
  };
  const scale = Math.min(size.width / frame.w, size.height / frame.h);
  const width = fit ? Math.round(frame.w * scale) : size.width;
  const height = fit ? Math.round(frame.h * scale) : size.height;
  const tx = (width - frame.w * scale) / 2 - frame.x * scale;
  const ty = (height - frame.h * scale) / 2 - frame.y * scale;
  const pen: Pen = { pixel: 1 / scale };
  let body = '';
  for (const [i, item] of shown.entries()) {
    const drawn = drawItem(item, pen, blocks, i);
    if (!drawn) continue;
    // A block keeps its turn as `prop:rotate` (a note, local change 56; an image).
    const rotate =
      Number(item.fields.rotate ?? item.fields['prop:rotate']) || 0;
    const { h, w, x, y } = item.box;
    body += rotate
      ? `<g transform="rotate(${num(rotate)} ${num(x + w / 2)} ${num(y + h / 2)})">${drawn}</g>`
      : drawn;
  }
  // The area's edge cuts what crosses it, in the margin a centred picture leaves.
  if (area)
    body = `<clipPath id="area"><rect x="${num(area.x)}" y="${num(area.y)}" width="${num(area.w)}" height="${num(area.h)}"/></clipPath><g clip-path="url(#area)">${body}</g>`;
  return `${head(width, height)}<g transform="matrix(${num(scale)} 0 0 ${num(scale)} ${num(tx)} ${num(ty)})" fill="none" stroke-linecap="round" stroke-linejoin="round" font-family="Inter, Arial, sans-serif">${body}</g></svg>`;
}

type Item = {
  box: Box;
  ends?: [Vec, Vec];
  fields: Fields;
  index: string;
  kind: string;
};
/** A placed quiz or flashcard set, named as the board catalog names it: this module
 * draws without the board's own code, which the app imports it without. */
const MATERIAL_CARD = 'affine:embed-capy-material';

/** One preview pixel in board units: lines never thinner, points never closer. */
type Pen = { pixel: number };

/** AFFiNE's own highlighter default, see-through. */
const HIGHLIGHTER = '#84cfff4d';
const FONT_SIZE_NOTE = 15;
const LINE_HEIGHT = 1.3;

function drawItem(
  { box, ends, fields, kind }: Item,
  pen: Pen,
  blocks: Record<string, Fields>,
  /** The item's place in the preview, so its own ids stay its own. */
  n: number
) {
  switch (kind) {
    case 'brush':
      return drawBrush(box, fields, pen, INK);
    case 'highlighter':
      return drawBrush(box, fields, pen, HIGHLIGHTER);
    case 'shape':
      return drawShape(box, fields, pen);
    case 'text':
      return lines(
        box,
        String(fields.text ?? ''),
        Number(fields.fontSize) || 16,
        colour(fields.color, INK),
        String(fields.textAlign ?? 'center')
      );
    case 'connector':
      return ends ? drawConnector(ends, fields, pen) : '';
    case 'plane':
      return drawPlane(box, fields, pen, n);
    case 'chart':
      return drawChart(box, fields, pen);
    case 'formula':
      return drawFormula(box, String(fields.latex ?? ''));
    case 'affine:note':
      return drawNote(box, fields, blocks);
    case MATERIAL_CARD:
      return drawMaterialCard(box, fields);
    case 'affine:image':
      return `${rect(box, '#f1f1ef', '#d9d9d6', pen.pixel)}`;
    default:
      return '';
  }
}

function drawBrush({ x, y }: Box, fields: Fields, pen: Pen, ink: string) {
  // Bytes the board's rules took, or none.
  const points = fields.points
    ? decodeStrokePoints(fields.points as Uint8Array)
    : [];
  if (!points.length) return '';
  const width = Math.max(Number(fields.lineWidth) || 4, pen.pixel);
  const stroke = colour(fields.color, ink);
  if (points.length === 1)
    return `<circle cx="${num(x + points[0][0])}" cy="${num(y + points[0][1])}" r="${num(width / 2)}" fill="${stroke}"/>`;
  let d = '';
  let last: StrokePoint | undefined;
  for (const [i, point] of points.entries()) {
    const end = i === points.length - 1;
    if (
      last &&
      !end &&
      Math.abs(point[0] - last[0]) + Math.abs(point[1] - last[1]) < pen.pixel
    )
      continue;
    d += `${last ? 'L' : 'M'}${num(x + point[0])} ${num(y + point[1])}`;
    last = point;
  }
  return `<path d="${d}" stroke="${stroke}" stroke-width="${num(width)}"/>`;
}

/** The polygon shape types' corners as fractions of their box: BlockSuite's
 * `POLYGON_SHAPES` (vendored local change 46), copied so a preview loads no editor;
 * boardPreview.test.ts checks they match. */
export const POLYGON_CORNERS: Record<string, Vec[]> = {
  hexagon: [
    [0.25, 0],
    [0.75, 0],
    [1, 0.5],
    [0.75, 1],
    [0.25, 1],
    [0, 0.5],
  ],
  parallelogram: [
    [0.25, 0],
    [1, 0],
    [0.75, 1],
    [0, 1],
  ],
  pentagon: [
    [0.5, 0],
    [1, 0.38],
    [0.81, 1],
    [0.19, 1],
    [0, 0.38],
  ],
  rightTriangle: [
    [0, 0],
    [1, 1],
    [0, 1],
  ],
  trapezium: [
    [0.25, 0],
    [0.75, 0],
    [1, 1],
    [0, 1],
  ],
};

function drawShape(box: Box, fields: Fields, pen: Pen) {
  const { h, w, x, y } = box;
  const fill = fields.filled ? colour(fields.fillColor, 'none') : 'none';
  const strokeStyle = fields.strokeStyle;
  const stroke =
    strokeStyle === 'none' ? 'none' : colour(fields.strokeColor, INK);
  const strokeWidth = Math.max(Number(fields.strokeWidth) || 2, pen.pixel);
  const dash =
    strokeStyle === 'dash'
      ? ` stroke-dasharray="${num(strokeWidth * 3)} ${num(strokeWidth * 3)}"`
      : '';
  const paint = `fill="${fill}" stroke="${stroke}" stroke-width="${num(strokeWidth)}"${dash}`;
  let outline: string;
  switch (fields.shapeType) {
    case 'ellipse':
      outline = `<ellipse cx="${num(x + w / 2)}" cy="${num(y + h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}" ${paint}/>`;
      break;
    case 'diamond':
      outline = `<path d="M${num(x + w / 2)} ${num(y)}L${num(x + w)} ${num(y + h / 2)}L${num(x + w / 2)} ${num(y + h)}L${num(x)} ${num(y + h / 2)}Z" ${paint}/>`;
      break;
    case 'triangle':
      outline = `<path d="M${num(x + w / 2)} ${num(y)}L${num(x + w)} ${num(y + h)}L${num(x)} ${num(y + h)}Z" ${paint}/>`;
      break;
    default: {
      const corners = POLYGON_CORNERS[String(fields.shapeType)];
      if (corners) {
        outline = `<path d="${corners
          .map(
            ([fx, fy], i) =>
              `${i ? 'L' : 'M'}${num(x + fx * w)} ${num(y + fy * h)}`
          )
          .join('')}Z" ${paint}/>`;
        break;
      }
      const radius = Number(fields.radius) || 0;
      const r = radius < 1 ? Math.min(w, h) * radius : radius;
      outline = `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(r)}" ${paint}/>`;
    }
  }
  const text = typeof fields.text === 'string' ? fields.text : '';
  if (!text) return outline;
  const fontSize = Number(fields.fontSize) || 20;
  const count = text.split('\n').length;
  const top = y + (h - count * fontSize * LINE_HEIGHT) / 2;
  return (
    outline +
    lines(
      { h, w, x, y: top },
      text,
      fontSize,
      colour(fields.color, INK),
      String(fields.textAlign ?? 'center')
    )
  );
}

/** Straight from end to end, with an arrowhead where the board draws one. */
function drawConnector([from, to]: [Vec, Vec], fields: Fields, pen: Pen) {
  const width = Math.max(Number(fields.strokeWidth) || 2, pen.pixel);
  const stroke = colour(fields.stroke, INK);
  let out = `<path d="M${num(from[0])} ${num(from[1])}L${num(to[0])} ${num(to[1])}" stroke="${stroke}" stroke-width="${num(width)}"/>`;
  const head = (tip: Vec, tail: Vec) => {
    const angle = Math.atan2(tip[1] - tail[1], tip[0] - tail[0]);
    const size = width * 3 + 6;
    const wing = (turn: number) =>
      `${num(tip[0] - size * Math.cos(angle + turn))} ${num(tip[1] - size * Math.sin(angle + turn))}`;
    return `<path d="M${wing(0.45)}L${num(tip[0])} ${num(tip[1])}L${wing(-0.45)}" stroke="${stroke}" stroke-width="${num(width)}"/>`;
  };
  if ((fields.rearEndpointStyle ?? 'Arrow') !== 'None') out += head(to, from);
  if ((fields.frontEndpointStyle ?? 'None') !== 'None') out += head(from, to);
  return out;
}

function endPoint(end: unknown, boxById: Map<string, Box>): Vec | null {
  const { id, position } = (end ?? {}) as {
    id?: string;
    position?: number[];
  };
  if (id) {
    const box = boxById.get(id);
    if (!box) return null;
    const [rx, ry] = position ?? [0.5, 0.5];
    return [box.x + box.w * rx, box.y + box.h * ry];
  }
  return position ? [position[0], position[1]] : null;
}

/** A keyed list as checked data holds it (a plane's elements, a chart's bars and
 * lines), in order. */
const listOf = <E extends Keyed>(value: unknown) =>
  readElements(Object.entries(value as Record<string, ElementEntry<E>>));

/** The card as the graph engine draws it on the light export paper (one renderer for
 * every graph, Epo 2026-11-16), at no less than half the card's own size so its marks
 * keep a pixel. No labels or formulas: the preview can't lay a formula out, and better
 * none than a broken one (Epo 2026-11-08). */
function drawPlane(box: Box, fields: Fields, pen: Pen, n: number) {
  const { h, w, x, y } = box;
  const k = Math.max(1 / pen.pixel, 0.5);
  const elements = listOf<GraphElement>(fields.elements).filter(
    ({ type }) => type !== 'text' && type !== 'formula'
  );
  const recorder = new SvgRecorder(w * k, h * k, canvasMeasure, `p${n}`);
  const view: View = {
    left: Number(fields.x0),
    ppuX: Number(fields.ppu) * k,
    ppuY: Number(fields.ppu) * k,
    top: Number(fields.y0),
  };
  drawGraph(
    recorder,
    { h: h * k, w: w * k, x: 0, y: 0 },
    view,
    {
      board: {
        axis: true,
        bbox: bboxOf(view, w * k, h * k),
        grid: true,
        polar: fields.polar === true,
      },
      elements,
    },
    EXPORT_PAPER
  );
  return recorder.nested(x, y, w, h);
}

/** Bars and the axes, or the circle and its spokes. */
function drawChart(box: Box, fields: Fields, pen: Pen) {
  const ink = Math.max(2, pen.pixel);
  let out = rect(box, '#fff', '#d9d9d6', Math.max(1, pen.pixel));
  if (fields.kind === 'bar') {
    const bars = listOf<ChartBar>(fields.bars);
    const axisMax = Number(fields.axisMax);
    const slots = Math.max(bars.length, 1);
    const { base, height, left, slotW, top, width } = barPlot(
      box,
      CARD_PADS.bar,
      slots
    );
    for (const [i, bar] of bars.entries()) {
      const w = slotW * BAR_SHARE;
      const x = left + slotW * i + (slotW - w) / 2;
      const y = base - (height * Math.min(bar.value, axisMax)) / axisMax;
      out += rect({ h: base - y, w, x, y }, colour(bar.fill, 'none'), INK, ink);
    }
    out += `<path d="M${num(left)} ${num(top)}V${num(base)}H${num(left + width)}" stroke="#6f6f6c" stroke-width="${num(Math.max(1.5, pen.pixel))}"/>`;
  } else {
    const spokes = listOf<PieSpoke>(fields.spokes);
    const { cx, cy, r } = pieCircle(box, CARD_PADS.pie);
    for (const { fill, from, to } of filledSlices(spokes)) {
      const paint = colour(fill, 'none');
      if (to - from >= 360) {
        out += `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${paint}"/>`;
        continue;
      }
      const [x0, y0] = onScreen(cx, cy, r, from);
      const [x1, y1] = onScreen(cx, cy, r, to);
      out += `<path d="M${num(cx)} ${num(cy)}L${num(x0)} ${num(y0)}A${num(r)} ${num(r)} 0 ${to - from > 180 ? 1 : 0} 1 ${num(x1)} ${num(y1)}Z" fill="${paint}"/>`;
    }
    const lines = spokes
      .map(({ angle }) => {
        const [sx, sy] = onScreen(cx, cy, r, angle);
        return `M${num(cx)} ${num(cy)}L${num(sx)} ${num(sy)}`;
      })
      .join('');
    out += `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" stroke="${INK}" stroke-width="${num(ink)}"/>`;
    if (lines)
      out += `<path d="${lines}" stroke="${INK}" stroke-width="${num(ink)}"/>`;
  }
  return out;
}

/** The LaTeX as typed, sized to the formula's box. */
function drawFormula(box: Box, latex: string) {
  const fontSize = Math.min(
    box.h * 0.6,
    box.w / Math.max(latex.length * 0.55, 1)
  );
  return `<text x="${num(box.x + box.w / 2)}" y="${num(box.y + box.h / 2)}" font-size="${num(fontSize)}" text-anchor="middle" dominant-baseline="central" fill="${INK}">${escapeText(latex)}</text>`;
}

/** The note's box and a line per paragraph, cut off at its edges. */
function drawNote(box: Box, note: Fields, blocks: Record<string, Fields>) {
  const texts: string[] = [];
  const walk = (ids: unknown) => {
    for (const id of (ids as string[] | undefined) ?? []) {
      const block = blocks[id];
      if (!block) continue;
      if (typeof block['prop:text'] === 'string')
        texts.push(block['prop:text']);
      walk(block['sys:children']);
    }
  };
  walk(note['sys:children']);
  const { h, w, x, y } = box;
  const text = texts.join('\n');
  const style = ((note['prop:edgeless'] as Fields | undefined)?.style ??
    {}) as Fields;
  const background = note['prop:background'];
  const bordered = style.borderStyle !== 'none';
  // An inline note (P1/I1, Epo 2026-11-13) is its text alone, with no padding.
  if (background === 'transparent' && !style.shadowType && !bordered)
    return lines(box, text, FONT_SIZE_NOTE, '#1d1d1f', 'left');
  // A card as the board draws it: 8 by 10 px padding, its corner, the fill half
  // see-through, its border, or the hairline every shadow is drawn as here.
  const inner = { h: h - 16, w: w - 20, x: x + 10, y: y + 8 };
  const edge = bordered
    ? `stroke="#1d1d1f" stroke-opacity="0.1" stroke-width="${num(Number(style.borderSize) || 4)}"${style.borderStyle === 'dash' ? ' stroke-dasharray="6 4"' : ''}`
    : style.shadowType
      ? 'stroke="#e6e6e6" stroke-width="1"'
      : '';
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(Number(style.borderRadius ?? 8))}" fill="${colour(background, '#fff')}" fill-opacity="0.5" ${edge}/><svg x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" overflow="hidden">${lines(inner, text, FONT_SIZE_NOTE, '#1d1d1f', 'left')}</svg>`;
}

/** A placed quiz or flashcard set: its box with the title and what it is, as the
 * note card draws its paragraphs (Epo 2026-11-09). */
function drawMaterialCard(box: Box, card: Fields) {
  const { h, w, x, y } = box;
  const what =
    card['prop:kind'] === 'flashcards'
      ? m.drawing_board_flashcards()
      : m.drawing_board_quiz();
  const title = String(card['prop:title'] ?? '');
  const inner = { h: h - 16, w: w - 20, x: x + 10, y: y + 8 };
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="6" fill="#fff" stroke="#e6e6e6" stroke-width="1"/><svg x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" overflow="hidden">${lines(inner, `${title}\n${what}`, FONT_SIZE_NOTE, '#1d1d1f', 'left')}</svg>`;
}

function lines(
  { w, x, y }: Box,
  text: string,
  fontSize: number,
  fill: string,
  align: string
) {
  if (!text) return '';
  const anchor =
    align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const at = align === 'left' ? x : align === 'right' ? x + w : x + w / 2;
  const step = fontSize * LINE_HEIGHT;
  const spans = text
    .split('\n')
    .map(
      (line, i) =>
        `<tspan x="${num(at)}" y="${num(y + step * i + step / 2)}">${escapeText(line)}</tspan>`
    )
    .join('');
  return `<text font-size="${num(fontSize)}" text-anchor="${anchor}" dominant-baseline="central" fill="${fill}" stroke="none">${spans}</text>`;
}

function rect(box: Box, fill: string, stroke: string, width: number) {
  return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" fill="${fill}" stroke="${stroke}" stroke-width="${num(width)}"/>`;
}

/** A board colour as the light theme shows it. */
function colour(value: unknown, fallback: string): string {
  if (typeof value === 'string')
    return value === 'transparent' || !SAFE_COLOUR.test(value)
      ? fallback
      : value;
  if (value && typeof value === 'object') {
    const { light, normal } = value as { light?: unknown; normal?: unknown };
    return colour(normal ?? light, fallback);
  }
  return fallback;
}
const SAFE_COLOUR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\))$/i;

const UNPLACED = new Set(['group', 'connector', 'mindmap']);

/** Whether two boxes meet, edges included. */
const overlaps = (a: Box, b: Box) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

function isOnCanvas(blocks: Record<string, Fields>, id: string) {
  return Object.values(blocks).some(
    (block) =>
      block['sys:flavour'] === 'affine:surface' &&
      (block['sys:children'] as string[]).includes(id)
  );
}

function boxOf(xywh: unknown): Box {
  const [x, y, w, h] = JSON.parse(String(xywh)) as number[];
  return { h, w, x, y };
}

const num = (value: number) => Math.round(value * 100) / 100;

const escapeText = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) =>
      ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] ?? char
  );
