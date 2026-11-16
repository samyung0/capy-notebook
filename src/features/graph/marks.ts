/* Where a graph's elements are on screen and how the editors' tools change them:
 * the geometry the canvas plane's editor and the question graph editor share
 * (Epo 2026-11-16, each editor gains the other's tools). Hit-testing is in screen
 * pixels, so a graph whose axes are scaled apart reads the same as the plane. */
import {
  curvePieces,
  functionRuns,
  curveSegments as segmentsOf,
} from './curves';
import { textBox } from './draw';
import { formulaBox, laidOut } from './formula';
import { type GraphElement, isFreeMark, type Vec } from './model';
import { toPlane, toScreen, type View } from './view';

type Curve = Extract<GraphElement, { type: 'curve' }>;
export type Ellipse = Extract<GraphElement, { type: 'ellipse' }>;
type PathMark = Extract<
  GraphElement,
  { type: 'curve' | 'ellipse' | 'polyline' }
>;

/** A number without float dust (0.30000000000000004 is 0.3). */
export const tidy = (value: number) => Number(value.toPrecision(12));

/** The nearest multiple of `step`, without the float dust that would show in a label. */
export function snapTo(value: number, step: number) {
  return tidy(Math.round(value / step) * step);
}

/** An upright ellipse's four handles: right, top, left, bottom. */
export const ellipseHandles = ({
  center: [cx, cy],
  radii: [rx, ry],
}: Pick<Ellipse, 'center' | 'radii'>): Vec[] => [
  [cx + rx, cy],
  [cx, cy + ry],
  [cx - rx, cy],
  [cx, cy - ry],
];

/** The points an element is drawn through, or at, that a press picks up. A
 * function has none, and a construction none of its own: the points it names
 * are elements of their own. */
export const pointsOf = (element: GraphElement): Vec[] =>
  element.type === 'polyline' || element.type === 'curve'
    ? element.coords
    : element.type === 'ellipse'
      ? ellipseHandles(element)
      : element.type === 'point' ||
          element.type === 'text' ||
          element.type === 'formula'
        ? [element.coords]
        : [];

/** The point elements by id, where constructions find theirs. */
export const pointsById = (elements: readonly GraphElement[]) =>
  new Map(
    elements.flatMap((element) =>
      element.type === 'point' ? [[element.id, element.coords] as const] : []
    )
  );

/** The point ids a construction is built on, its centre first. */
export function namedPoints(element: GraphElement): string[] {
  if (
    element.type === 'circle' ||
    element.type === 'arc' ||
    element.type === 'sector'
  )
    return [element.center, ...('points' in element ? element.points : [])];
  return 'points' in element ? element.points : [];
}

/** Whether a curve closes on its start, as `curvePieces` takes it: its first and last
 * points are one point, smooth across the seam. */
export const isLoop = (points: Vec[]) => {
  const [first, end] = [points[0], points.at(-1)];
  return points.length > 3 && end?.[0] === first[0] && end[1] === first[1];
};

/** Each point's [in, out] handles as the smooth curve through them has them; a loop's
 * seam has both, on its first and last point alike. */
export function smoothHandles(points: Vec[]): [Vec, Vec][] {
  const pieces = curvePieces(points);
  const loop = isLoop(points);
  return points.map((point, i): [Vec, Vec] => [
    pieces[i - 1]?.[2] ?? (loop ? pieces.at(-1)?.[2] : undefined) ?? point,
    pieces[i]?.[1] ?? (loop ? pieces[0]?.[1] : undefined) ?? point,
  ]);
}

/** A curve's pieces as cubic Béziers: from, its two controls, to. */
export const curveSegments = (mark: Curve) =>
  segmentsOf(mark.coords, mark.handles);

/** A point along a cubic Bézier piece, `t` from 0 to 1. */
export const bezier = ([a, b, c, d]: [Vec, Vec, Vec, Vec], t: number): Vec => {
  const u = 1 - t;
  return [0, 1].map(
    (k) =>
      u * u * u * a[k] +
      3 * u * u * t * b[k] +
      3 * u * t * t * c[k] +
      t ** 3 * d[k]
  ) as Vec;
};

/** A circle round `at` on the grid, as the Ellipse tool places one. */
export const circleAt = (id: string, [x, y]: Vec, r: number): Ellipse => ({
  center: [tidy(x), tidy(y)],
  id,
  radii: [tidy(r), tidy(r)],
  type: 'ellipse',
});

/** The ellipse after handle `index` (right, top, left, bottom) is pulled to `to`:
 * right or left sets the width and top or bottom the height, about the middle, so it
 * stays put on the grid. `uniform` (Shift) scales the other way by as much, keeping
 * its shape. A pull onto the middle keeps the size. */
export function pullEllipse(
  ellipse: Ellipse,
  index: number,
  to: Vec,
  uniform = false
): Ellipse {
  const [cx, cy] = ellipse.center;
  let [rx, ry] = ellipse.radii;
  if (index % 2 === 0) {
    const next = Math.abs(to[0] - cx) || rx;
    if (uniform && rx) ry *= next / rx;
    rx = next;
  } else {
    const next = Math.abs(to[1] - cy) || ry;
    if (uniform && ry) rx *= next / ry;
    ry = next;
  }
  return { ...ellipse, radii: [tidy(rx), tidy(ry)] };
}

/** What a line, curve or ellipse draws through, as short straight steps. */
export function pathOf(mark: PathMark, perSegment = 16): Vec[] {
  if (mark.type === 'curve') {
    const pieces = curveSegments(mark);
    if (!pieces.length) return mark.coords;
    return [
      ...pieces.flatMap((piece) =>
        Array.from({ length: perSegment }, (_, step) =>
          bezier(piece, step / perSegment)
        )
      ),
      mark.coords.at(-1) as Vec,
    ];
  }
  if (mark.type === 'polyline') return mark.coords;
  const [[cx, cy], [rx, ry]] = [mark.center, mark.radii];
  const steps = perSegment * 4;
  return Array.from({ length: steps + 1 }, (_, i): Vec => {
    const turn = (i / steps) * Math.PI * 2;
    return [cx + rx * Math.cos(turn), cy + ry * Math.sin(turn)];
  });
}

/** Round `center` from the direction of `from` counterclockwise to `to`'s, at
 * `from`'s distance, as an arc or sector is drawn. */
function arcPath(center: Vec, from: Vec, to: Vec): Vec[] {
  const r = Math.hypot(from[0] - center[0], from[1] - center[1]);
  const start = Math.atan2(from[1] - center[1], from[0] - center[0]);
  let end = Math.atan2(to[1] - center[1], to[0] - center[0]);
  if (end <= start) end += Math.PI * 2;
  return Array.from({ length: 49 }, (_, i): Vec => {
    const turn = start + ((end - start) * i) / 48;
    return [center[0] + r * Math.cos(turn), center[1] + r * Math.sin(turn)];
  });
}

/** What a construction draws through on the plane, as straight steps; a line's
 * two points stand for it (`infinite` says it runs on). */
function constructionPath(
  element: GraphElement,
  points: ReadonlyMap<string, Vec>
): { infinite: boolean; path: Vec[] } | null {
  const named = namedPoints(element).map((id) => points.get(id));
  if (!named.every(Boolean)) return null;
  const at = named as Vec[];
  switch (element.type) {
    case 'line':
      return { infinite: true, path: at };
    case 'segment':
      return { infinite: false, path: at };
    case 'polygon':
      return { infinite: false, path: [...at, at[0]] };
    case 'circle':
      return {
        infinite: false,
        path: pathOf({
          center: at[0],
          id: '',
          radii: [element.radius, element.radius],
          type: 'ellipse',
        }),
      };
    case 'arc':
      return { infinite: false, path: arcPath(at[0], at[1], at[2]) };
    case 'sector':
      return {
        infinite: false,
        path: [at[0], ...arcPath(at[0], at[1], at[2]), at[0]],
      };
    default:
      return null;
  }
}

/** How far a pixel is from a path of straight screen steps. */
function alongPath(points: Vec[], [x, y]: Vec) {
  const between = (a: Vec, b: Vec) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = dx * dx + dy * dy;
    const t = length
      ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length))
      : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  return points.length > 1
    ? Math.min(...points.slice(1).map((p, i) => between(points[i], p)))
    : Math.hypot(x - points[0][0], y - points[0][1]);
}

/** How far a pixel is from the infinite line through two screen points. */
function fromLine([a, b]: Vec[], [x, y]: Vec) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(dx, dy);
  if (!length) return Math.hypot(x - a[0], y - a[1]);
  return Math.abs((x - a[0]) * dy - (y - a[1]) * dx) / length;
}

/** An angle's arc, in screen pixels round its middle point, as it is drawn. */
const ANGLE_REACH = 24;

/** How far an element's stroke is from a pixel, in screen pixels: a function is
 * only looked for within `reach` pixels across, where any of it in reach must
 * be. Labels and formulas count from their point. */
export function distanceTo(
  element: GraphElement,
  px: Vec,
  view: View,
  points: ReadonlyMap<string, Vec>,
  reach: number
) {
  const screen = (path: Vec[]) => path.map((p) => toScreen(view, p));
  if (element.type === 'functiongraph') {
    const [x] = toPlane(view, px);
    const across = reach / view.ppuX;
    return Math.min(
      Number.POSITIVE_INFINITY,
      ...functionRuns(
        element,
        x - across,
        x + across,
        across / 16,
        Number.POSITIVE_INFINITY
      ).map((run) => alongPath(screen(run), px))
    );
  }
  if (
    element.type === 'point' ||
    element.type === 'text' ||
    element.type === 'formula'
  ) {
    const [x, y] = toScreen(view, element.coords);
    return Math.hypot(px[0] - x, px[1] - y);
  }
  if (
    element.type === 'polyline' ||
    element.type === 'curve' ||
    element.type === 'ellipse'
  )
    return alongPath(screen(pathOf(element)), px);
  if (element.type === 'angle') {
    const vertex = points.get(element.points[1]);
    if (!vertex) return Number.POSITIVE_INFINITY;
    const [x, y] = toScreen(view, vertex);
    return Math.abs(Math.hypot(px[0] - x, px[1] - y) - ANGLE_REACH);
  }
  const drawn = constructionPath(element, points);
  if (!drawn) return Number.POSITIVE_INFINITY;
  const path = screen(drawn.path);
  return drawn.infinite ? fromLine(path, px) : alongPath(path, px);
}

/** Whether segment ab crosses segment cd. */
function crosses(a: Vec, b: Vec, c: Vec, d: Vec) {
  const side = (p: Vec, q: Vec, r: Vec) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

type TextMeasure = Parameters<typeof textBox>[0];

/** A label's or formula's text on screen; a formula not laid out yet has none. */
export function textBoxOf(
  element: GraphElement,
  view: View,
  measure: TextMeasure,
  labelSize: number
) {
  if (element.type === 'text')
    return textBox(
      measure,
      element.text,
      element.size ?? labelSize,
      ...toScreen(view, element.coords)
    );
  if (element.type !== 'formula') return null;
  const drawn = laidOut(element.latex);
  return drawn
    ? formulaBox(drawn, ...toScreen(view, element.coords), element.size)
    : null;
}

/** Whether an element has any part inside a box of pixels, as the board's
 * selection box picks what it touches. */
export function touches(
  element: GraphElement,
  [ax, ay]: Vec,
  [bx, by]: Vec,
  view: View,
  points: ReadonlyMap<string, Vec>,
  measure: TextMeasure,
  labelSize: number
) {
  const [x0, x1, y0, y1] = [
    Math.min(ax, bx),
    Math.max(ax, bx),
    Math.min(ay, by),
    Math.max(ay, by),
  ];
  const inside = ([x, y]: Vec) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const screen = (p: Vec) => toScreen(view, p);
  if (element.type === 'formula' || element.type === 'text') {
    const box = textBoxOf(element, view, measure, labelSize);
    if (!box) return inside(screen(element.coords));
    return (
      box.x <= x1 && box.x + box.w >= x0 && box.y <= y1 && box.y + box.h >= y0
    );
  }
  if (element.type === 'functiongraph')
    return functionRuns(
      element,
      toPlane(view, [x0, 0])[0],
      toPlane(view, [x1, 0])[0],
      2 / view.ppuX,
      Number.POSITIVE_INFINITY
    ).some((run) => run.some((point) => inside(screen(point))));
  let onScreen: Vec[];
  if (element.type === 'point') onScreen = [screen(element.coords)];
  else if (
    element.type === 'polyline' ||
    element.type === 'curve' ||
    element.type === 'ellipse'
  )
    onScreen = pathOf(element).map(screen);
  else if (element.type === 'angle') {
    const vertex = points.get(element.points[1]);
    onScreen = vertex ? [screen(vertex)] : [];
  } else {
    const drawn = constructionPath(element, points);
    if (!drawn) return false;
    onScreen = drawn.path.map(screen);
    if (drawn.infinite) {
      // A line runs on: far past the screen both ways.
      const [a, b] = onScreen;
      const far = 1e6 / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
      const [dx, dy] = [(b[0] - a[0]) * far, (b[1] - a[1]) * far];
      onScreen = [
        [a[0] - dx, a[1] - dy],
        [a[0] + dx, a[1] + dy],
      ];
    }
  }
  if (onScreen.some(inside)) return true;
  const corners: Vec[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  return onScreen
    .slice(1)
    .some((b, i) =>
      corners.some((c, j) => crosses(onScreen[i], b, c, corners[(j + 1) % 4]))
    );
}

const same = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;

export { same as samePoint };

/** Whether a point's two handles lie on one line through it, so pulling one turns
 * the other (a smooth point); an end, with one handle, counts as smooth. */
function smoothAt(point: Vec, [into, out]: [Vec, Vec]) {
  if (same(into, point) || same(out, point)) return true;
  const a = Math.atan2(point[1] - into[1], point[0] - into[0]);
  const b = Math.atan2(out[1] - point[1], out[0] - point[0]);
  const turn = Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  return turn < 0.05;
}

/** A point's [in, out] handles. A loop's seam is one point drawn as its first and
 * last: its in-handle is the last one's and its out-handle the first one's. */
export function pairOf(
  handles: [Vec, Vec][],
  index: number,
  loop: boolean
): [Vec, Vec] {
  const last = handles.length - 1;
  return loop && (index === 0 || index === last)
    ? [handles[last][0], handles[0][1]]
    : [handles[index][0], handles[index][1]];
}
function putPair(
  handles: [Vec, Vec][],
  index: number,
  loop: boolean,
  pair: [Vec, Vec]
) {
  if (loop && (index === 0 || index === handles.length - 1)) {
    handles[0] = [pair[0], pair[1]];
    handles[handles.length - 1] = [pair[0], pair[1]];
  } else handles[index] = pair;
}

/** `handles[index]`'s other handle turned to stay on the line through its point, at
 * its own length. */
function turnOther(point: Vec, pair: [Vec, Vec], moved: 0 | 1) {
  const other = moved ? 0 : 1;
  const length = Math.hypot(
    pair[other][0] - point[0],
    pair[other][1] - point[1]
  );
  const [dx, dy] = [point[0] - pair[moved][0], point[1] - pair[moved][1]];
  const away = Math.hypot(dx, dy);
  if (!length || !away) return;
  pair[other] = [
    point[0] + (dx / away) * length,
    point[1] + (dy / away) * length,
  ];
}

export const handlesOf = (mark: Curve) =>
  mark.handles ?? smoothHandles(mark.coords);

/** A curve with one handle of a point pulled to `to`. A smooth point's other handle
 * turns with it, unless `alone` (Alt), which leaves a corner (Epo 2026-11-13, K1). */
export function pulledHandle(
  mark: Curve,
  index: number,
  side: 0 | 1,
  to: Vec,
  alone: boolean
): Curve {
  const handles = handlesOf(mark).map(([a, b]): [Vec, Vec] => [a, b]);
  const loop = isLoop(mark.coords);
  const point = mark.coords[index];
  const pair = pairOf(handles, index, loop);
  const smooth = !alone && smoothAt(point, pair);
  pair[side] = to;
  if (smooth) turnOther(point, pair, side);
  putPair(handles, index, loop, pair);
  return { ...mark, handles };
}

/** A curve point made a corner (both handles on it), or smooth again (K1). */
export function toggledCorner(mark: Curve, index: number): Curve {
  const handles = handlesOf(mark).map(([a, b]): [Vec, Vec] => [a, b]);
  const loop = isLoop(mark.coords);
  const at = mark.coords[index];
  const [into, out] = pairOf(handles, index, loop);
  putPair(
    handles,
    index,
    loop,
    same(into, at) && same(out, at)
      ? pairOf(smoothHandles(mark.coords), index, loop)
      : [at, at]
  );
  return { ...mark, handles };
}

/** A press on a curve's stroke, between its points: piece `piece` at `t`, with the
 * handles as they were. */
export type Bend = {
  from: Vec;
  handles: [Vec, Vec][];
  piece: number;
  t: number;
};

/** The curve with piece `bend.piece` pulled through the pointer at its `t`, its two
 * inner handles moving by their share and its points staying smooth (Epo
 * 2026-11-13, K2). */
export function bent(mark: Curve, bend: Bend, to: Vec): Curve {
  const t = Math.min(0.9, Math.max(0.1, bend.t));
  const u = 1 - t;
  const k = 1 / (3 * t * u * (u * u + t * t));
  const [dx, dy] = [to[0] - bend.from[0], to[1] - bend.from[1]];
  const handles = bend.handles.map(([a, b]): [Vec, Vec] => [a, b]);
  const loop = isLoop(mark.coords);
  const { piece } = bend;
  const [start, end] = [
    pairOf(handles, piece, loop),
    pairOf(handles, piece + 1, loop),
  ];
  const smooth = [
    smoothAt(mark.coords[piece], pairOf(bend.handles, piece, loop)),
    smoothAt(mark.coords[piece + 1], pairOf(bend.handles, piece + 1, loop)),
  ];
  start[1] = [start[1][0] + dx * k * u, start[1][1] + dy * k * u];
  end[0] = [end[0][0] + dx * k * t, end[0][1] + dy * k * t];
  if (smooth[0]) turnOther(mark.coords[piece], start, 1);
  if (smooth[1]) turnOther(mark.coords[piece + 1], end, 0);
  putPair(handles, piece, loop, start);
  putPair(handles, piece + 1, loop, end);
  return { ...mark, handles };
}

/** A free mark or point with its point `index` at `to`, or (`index` null) all of
 * it moved by `to`. A function stays where its expression puts it, and a
 * construction where its points are. */
export function moved(
  mark: GraphElement,
  index: number | null,
  to: Vec,
  uniform: boolean
): GraphElement {
  if (!(isFreeMark(mark) || mark.type === 'point' || mark.type === 'text'))
    return mark;
  const by = (p: Vec): Vec => [tidy(p[0] + to[0]), tidy(p[1] + to[1])];
  if (mark.type === 'ellipse')
    return index === null
      ? { ...mark, center: by(mark.center) }
      : pullEllipse(mark, index, to, uniform);
  if (mark.type === 'polyline' || mark.type === 'curve') {
    if (index === null)
      return mark.type === 'curve'
        ? {
            ...mark,
            coords: mark.coords.map(by),
            ...(mark.handles && {
              handles: mark.handles.map(([a, b]): [Vec, Vec] => [by(a), by(b)]),
            }),
          }
        : { ...mark, coords: mark.coords.map(by) };
    // A point takes its handles along.
    const from = mark.coords[index];
    const shift = (p: Vec): Vec => [
      p[0] + to[0] - from[0],
      p[1] + to[1] - from[1],
    ];
    const coords = mark.coords.map((p, i) => (i === index ? to : p));
    return mark.type === 'curve'
      ? {
          ...mark,
          coords,
          ...(mark.handles && {
            handles: mark.handles.map((pair, i): [Vec, Vec] =>
              i === index ? [shift(pair[0]), shift(pair[1])] : pair
            ),
          }),
        }
      : { ...mark, coords };
  }
  return { ...mark, coords: index === null ? by(mark.coords) : to };
}

/** `group` moved whole by `by`: free marks, points and labels by themselves, and a
 * construction by the points it is built on, each point once, so a segment
 * dragged takes its two points along (as GeoGebra moves a free segment). */
export function movedGroup(
  elements: readonly GraphElement[],
  group: ReadonlySet<string>,
  by: Vec
): GraphElement[] {
  const carried = new Set<string>();
  for (const element of elements)
    if (group.has(element.id))
      for (const id of namedPoints(element)) carried.add(id);
  return elements.flatMap((element) => {
    if (!(group.has(element.id) || carried.has(element.id))) return [];
    const next = moved(element, null, by, false);
    return next === element ? [] : [next];
  });
}

/** The ids `gone` takes with it: what is built on a point that goes goes too, as
 * GeoGebra deletes what depends on a deleted point. */
export function withDependents(
  elements: readonly GraphElement[],
  gone: ReadonlySet<string>
): Set<string> {
  const out = new Set(gone);
  for (const element of elements)
    if (namedPoints(element).some((id) => out.has(id))) out.add(element.id);
  return out;
}

/** Whether an element has become what it set out to be: a line or curve needs two
 * points. Leaving keeps what has, and removes what hasn't, as AFFiNE removes a
 * connector it cancels. */
export const whole = (element: GraphElement) =>
  !(element.type === 'polyline' || element.type === 'curve') ||
  element.coords.length > 1;
