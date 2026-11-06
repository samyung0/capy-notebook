import { tickStep } from '@/features/questions/graphTicks';
import { fromBase64 } from './base64';
import {
  BAR_SHARE,
  barPlot,
  CARD_PADS,
  type ChartData,
  INK,
  type Mark,
  onScreen,
  pieCircle,
} from './boardData';
import {
  type Box,
  closeUp,
  IMAGE_SIDE_MAX,
  smoothThrough,
  ticks,
  unite,
  type Vec,
} from './boardGeometry';
import { BoardLoadError, checkSavedBoard, type Fields } from './boardLoad';

/** A saved board drawn from its data as an SVG string, for lists, results and marking
 * views, without the editor: what's on it, not every detail (Epo 2026-11-06). Framed as
 * the marking image is: everything on the board, far groups drawn nearer, on white.
 * Strokes are plain lines, connectors straight, formulas their LaTeX, notes a line per
 * paragraph, pasted images a grey box, and no numbers or labels on cards. Throws a
 * BoardLoadError for a board that doesn't check out. */
export function drawBoardPreview(
  saved: string,
  size: { height: number; width: number }
) {
  let update: Uint8Array;
  try {
    update = fromBase64(saved);
  } catch (cause) {
    throw new BoardLoadError('unreadable', { cause });
  }
  const { blocks, elements } = checkSavedBoard(update);
  // Where each card, shape, note and image sits, for the connectors' ends.
  const placed = [
    ...Object.entries(elements).filter(
      ([, element]) => element.type !== 'group' && element.type !== 'connector'
    ),
    ...Object.entries(blocks).filter(
      ([id, block]) =>
        // A note kept for page mode only isn't on the canvas.
        (block['sys:flavour'] === 'affine:note' &&
          block['prop:displayMode'] !== 'doc') ||
        (block['sys:flavour'] === 'affine:image' && isOnCanvas(blocks, id))
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

  const { height, width } = size;
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/>`;
  if (!items.length) return `${head}</svg>`;

  const boxes = items.map((item) => item.box);
  const whole = unite(boxes);
  const shifts =
    Math.max(whole.w, whole.h) > IMAGE_SIDE_MAX
      ? closeUp(boxes)
      : boxes.map(() => ({ dx: 0, dy: 0 }));
  const all = unite(
    boxes.map((box, i) => ({
      ...box,
      x: box.x - shifts[i].dx,
      y: box.y - shifts[i].dy,
    }))
  );
  const frame = { h: all.h + 16, w: all.w + 16, x: all.x - 8, y: all.y - 8 };
  const scale = Math.min(width / frame.w, height / frame.h);
  const tx = (width - frame.w * scale) / 2 - frame.x * scale;
  const ty = (height - frame.h * scale) / 2 - frame.y * scale;
  const pen: Pen = { pixel: 1 / scale };
  let body = '';
  for (const [i, item] of items.entries()) {
    const drawn = drawItem(item, pen, blocks);
    if (!drawn) continue;
    const { dx, dy } = shifts[i];
    const rotate = Number(item.fields.rotate) || 0;
    const { h, w, x, y } = item.box;
    const moves = [
      dx || dy ? `translate(${num(-dx)} ${num(-dy)})` : '',
      rotate
        ? `rotate(${num(rotate)} ${num(x + w / 2)} ${num(y + h / 2)})`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    body += moves ? `<g transform="${moves}">${drawn}</g>` : drawn;
  }
  return `${head}<g transform="matrix(${num(scale)} 0 0 ${num(scale)} ${num(tx)} ${num(ty)})" fill="none" stroke-linecap="round" stroke-linejoin="round" font-family="Inter, Arial, sans-serif">${body}</g></svg>`;
}

type Item = {
  box: Box;
  ends?: [Vec, Vec];
  fields: Fields;
  index: string;
  kind: string;
};
/** One preview pixel in board units: lines never thinner, points never closer. */
type Pen = { pixel: number };

const FONT_SIZE_NOTE = 15;
const LINE_HEIGHT = 1.3;

function drawItem(
  { box, ends, fields, kind }: Item,
  pen: Pen,
  blocks: Record<string, Fields>
) {
  switch (kind) {
    case 'brush':
      return drawBrush(box, fields, pen);
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
      return drawPlane(box, fields, pen);
    case 'chart':
      return drawChart(box, fields as unknown as ChartData, pen);
    case 'formula':
      return drawFormula(box, String(fields.latex ?? ''));
    case 'affine:note':
      return drawNote(box, fields, blocks);
    case 'affine:image':
      return `${rect(box, '#f1f1ef', '#d9d9d6', pen.pixel)}`;
    default:
      return '';
  }
}

function drawBrush({ x, y }: Box, fields: Fields, pen: Pen) {
  const points = ((fields.points as unknown[] | undefined) ?? []).filter(
    (point): point is number[] => Array.isArray(point) && point.length >= 2
  );
  if (!points.length) return '';
  const width = Math.max(Number(fields.lineWidth) || 4, pen.pixel);
  const stroke = colour(fields.color, INK);
  if (points.length === 1)
    return `<circle cx="${num(x + points[0][0])}" cy="${num(y + points[0][1])}" r="${num(width / 2)}" fill="${stroke}"/>`;
  let d = '';
  let last: number[] | undefined;
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

/** The card, its numbered grid lines while they're apart, the axes and the marks. */
function drawPlane(box: Box, fields: Fields, pen: Pen) {
  const { h, w, x, y } = box;
  const ppu = Number(fields.ppu);
  const x0 = Number(fields.x0);
  const y0 = Number(fields.y0);
  const marks = (fields.marks as Mark[] | undefined) ?? [];
  const X = (u: number) => x + (u - x0) * ppu;
  const Y = (v: number) => y + (y0 - v) * ppu;
  const step = tickStep(ppu);
  let grid = '';
  if (step * ppu > pen.pixel * 6) {
    for (const u of ticks(x0, x0 + w / ppu, step))
      grid += `M${num(X(u))} ${num(y)}V${num(y + h)}`;
    for (const v of ticks(y0 - h / ppu, y0, step))
      grid += `M${num(x)} ${num(Y(v))}H${num(x + w)}`;
  }
  const axes = `M${num(X(0))} ${num(y)}V${num(y + h)}M${num(x)} ${num(Y(0))}H${num(x + w)}`;
  const ink = Math.max(2, pen.pixel);
  let traces = '';
  let dots = '';
  const dot = ([u, v]: Vec) => {
    dots += `M${num(X(u))} ${num(Y(v))}h0`;
  };
  for (const mark of marks) {
    if (mark.kind === 'dot') {
      dot(mark.at);
      continue;
    }
    const path =
      mark.kind === 'curve' ? smoothThrough(mark.points, 6) : mark.points;
    traces += path
      .map(([u, v], i) => `${i ? 'L' : 'M'}${num(X(u))} ${num(Y(v))}`)
      .join('');
    for (const point of mark.points) dot(point);
  }
  return `<svg x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" overflow="hidden">${rect(box, '#fff', 'none', 0)}${grid ? `<path d="${grid}" stroke="#dededb" stroke-width="${num(Math.max(1, pen.pixel))}"/>` : ''}<path d="${axes}" stroke="#6f6f6c" stroke-width="${num(Math.max(1.5, pen.pixel))}"/>${traces ? `<path d="${traces}" stroke="${INK}" stroke-width="${num(ink)}"/>` : ''}${dots ? `<path d="${dots}" stroke="${INK}" stroke-width="${num(Math.max(9, pen.pixel * 2))}"/>` : ''}</svg>${rect(box, 'none', '#d9d9d6', Math.max(1, pen.pixel))}`;
}

/** Bars and the axes, or the circle and its spokes. */
function drawChart(box: Box, chart: ChartData, pen: Pen) {
  const ink = Math.max(2, pen.pixel);
  let out = rect(box, '#fff', '#d9d9d6', Math.max(1, pen.pixel));
  if (chart.kind === 'bar') {
    const slots = Math.max(chart.bars.length, 1);
    const { base, height, left, slotW, top, width } = barPlot(
      box,
      CARD_PADS.bar,
      slots
    );
    for (const [i, bar] of chart.bars.entries()) {
      const w = slotW * BAR_SHARE;
      const x = left + slotW * i + (slotW - w) / 2;
      const y =
        base - (height * Math.min(bar.value, chart.axisMax)) / chart.axisMax;
      out += rect({ h: base - y, w, x, y }, colour(bar.fill, 'none'), INK, ink);
    }
    out += `<path d="M${num(left)} ${num(top)}V${num(base)}H${num(left + width)}" stroke="#6f6f6c" stroke-width="${num(Math.max(1.5, pen.pixel))}"/>`;
  } else {
    const { cx, cy, r } = pieCircle(box, CARD_PADS.pie);
    const spokes = chart.spokes
      .map((spoke) => {
        const [sx, sy] = onScreen(cx, cy, r, spoke);
        return `M${num(cx)} ${num(cy)}L${num(sx)} ${num(sy)}`;
      })
      .join('');
    out += `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" stroke="${INK}" stroke-width="${num(ink)}"/>`;
    if (spokes)
      out += `<path d="${spokes}" stroke="${INK}" stroke-width="${num(ink)}"/>`;
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
  const pad = 16;
  const inner = { h: h - pad * 2, w: w - pad * 2, x: x + pad, y: y + pad };
  return `${rect(box, colour(note['prop:background'], '#fff'), '#d9d9d6', 1)}<svg x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" overflow="hidden">${lines(inner, texts.join('\n'), FONT_SIZE_NOTE, '#1d1d1f', 'left')}</svg>`;
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
