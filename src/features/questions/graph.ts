import type {
  BoardAttributes,
  GeometryElement,
  Point,
  TextAttributes,
} from 'jsxgraph';
import * as limits from '@/api/limits.generated';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import { runtimeTerm } from './graphSyntax';
import type { GraphBlock, GraphElement } from './types';
import { validGraphTerm } from './validation';

/** A graph that cannot be drawn; its message is localized copy. */
export class GraphError extends CopyError {}

const LOCAL_SVG_URL = /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g;

/** Label text wraps at this width in board pixels (Epo 2026-10-17). */
const LABEL_WIDTH = 200;
const SVG_NS = 'http://www.w3.org/2000/svg';
const AFTER_SPACE = /(?<=\s)/;
const LEADING_MINUS = /^-/;
let measureContext: CanvasRenderingContext2D | null = null;

/** Greedy lines of at most LABEL_WIDTH in JSXGraph's 12px text; a word wider
 * than that (or unspaced CJK) breaks between characters. */
export function wrapLabel(
  text: string,
  measure: (line: string) => number
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(AFTER_SPACE)) {
    if (measure((line + word).trimEnd()) <= LABEL_WIDTH) {
      line += word;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    for (const char of word) {
      if (line && measure(line + char) > LABEL_WIDTH) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

function measureLabel(line: string) {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) return 0;
  measureContext.font = '12px Arial, Helvetica, Geneva, sans-serif';
  return measureContext.measureText(line).width;
}

export function validateGraphTerm(term: string): void {
  if (!validGraphTerm(term))
    throw new GraphError(
      m.question_ui_use_a_supported_mathematical_expression_in_x()
    );
}

export function validateGraphRecipe(graph: GraphBlock): void {
  const [left, top, right, bottom] = graph.board.bbox;
  if (
    ![left, top, right, bottom, graph.width, graph.height].every(
      Number.isFinite
    ) ||
    left >= right ||
    bottom >= top ||
    ![graph.width, graph.height].every(
      (n) =>
        n >= limits.QUESTION_GRAPH_DIMENSION_MIN &&
        n <= limits.QUESTION_GRAPH_DIMENSION_MAX
    )
  )
    throw new GraphError(
      m.question_ui_enter_valid_graph_bounds_and_dimensions()
    );
  if (graph.elements.length > limits.QUESTION_GRAPH_ELEMENTS_MAX)
    throw new GraphError(
      m.question_ui_a_graph_can_contain_at_most_60_elements()
    );
  const ids = new Set<string>();
  const points = new Set(
    graph.elements
      .filter((element) => element.type === 'point')
      .map((element) => element.id)
  );
  for (const element of graph.elements) {
    if (!element.id || ids.has(element.id))
      throw new GraphError(
        m.question_ui_graph_elements_need_unique_identifiers()
      );
    ids.add(element.id);
    if (element.type === 'functiongraph') {
      validateGraphTerm(element.term);
      if (
        element.domain &&
        (!element.domain.every(Number.isFinite) ||
          element.domain[0] >= element.domain[1])
      )
        throw new GraphError(m.question_ui_enter_a_valid_function_domain());
    }
    if (
      (element.type === 'point' || element.type === 'text') &&
      !element.coords.every(Number.isFinite)
    )
      throw new GraphError(m.question_ui_enter_valid_coordinates());
    if (
      'points' in element &&
      (new Set(element.points).size !== element.points.length ||
        element.points.some((id) => !points.has(id)))
    )
      throw new GraphError(m.question_ui_select_different_points());
    if (
      'center' in element &&
      (!points.has(element.center) ||
        ('points' in element && element.points.includes(element.center)))
    )
      throw new GraphError(m.question_ui_select_a_center_point());
    if (
      element.type === 'circle' &&
      (!Number.isFinite(element.radius) || element.radius <= 0)
    )
      throw new GraphError(
        m.question_ui_select_a_center_and_a_positive_radius()
      );
  }
}

/** Editor hooks: the board becomes pannable, zoomable and draggable. */
export type GraphBoardHooks = {
  /** The visible area after a pan or zoom. */
  onBoundingBox: (bbox: GraphBlock['board']['bbox']) => void;
  /** A dragged point or label, rounded to the board's current precision. */
  onMove: (id: string, coords: [number, number]) => void;
};

const sameBox = (a: number[], b: number[]) =>
  a.every(
    (value, i) =>
      Math.abs(value - b[i]) <= 1e-9 * Math.max(1, Math.abs(a[0] - a[2]))
  );

type Bbox = GraphBlock['board']['bbox'];

/**
 * JSXGraph treats anything under 1e-6 as zero and its grid breaks far from the
 * origin, so the board draws in local units: a value is `origin + unit * board`.
 * One unit for both axes keeps circles round; each origin sits on a multiple
 * of every tick step so grid lines meet the ticks.
 */
type Frame = { ox: number; oy: number; unit: number };

const magnitude = (span: number) => 10 ** Math.floor(Math.log10(span / 10));

function frameFor([left, top, right, bottom]: Bbox): Frame {
  const origin = (from: number, to: number) => {
    const round = 100 * magnitude(to - from);
    return Math.round((from + to) / 2 / round) * round;
  };
  return {
    ox: origin(left, right),
    oy: origin(bottom, top),
    unit: magnitude(Math.min(right - left, top - bottom)),
  };
}

/** GeoGebra's tick step: 100px worth of units rounded down to 1, 2 or 5 × 10ⁿ. */
export function tickStep(pixelsPerUnit: number) {
  const units = 100 / pixelsPerUnit;
  const power = 10 ** Math.floor(Math.log10(units));
  const n = units / power;
  return (n > 5 ? 5 : n > 2 ? 2 : 1) * power;
}

/** A tick number as GeoGebra writes it: plain with enough decimals for the
 * step, scientific (`5E8`) when the step is under 10⁻⁵ or over 10⁷, an en
 * dash for minus; empty at 0, where the axes cross. */
export function axisNumber(value: number, step: number) {
  if (Math.abs(value) < step * 1e-9) return '';
  const digits = Math.min(14, Math.max(-Math.floor(Math.log10(step)), 2));
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    useGrouping: false,
    ...((step < 1e-5 || step > 1e7) && { notation: 'scientific' }),
  })
    .format(value)
    .replace(LEADING_MINUS, '\u2013');
}

/** GeoGebra's zoom range, in pixels per unit. */
const SCALE_MIN = 1e-15;
const SCALE_MAX = 1e15;

export async function createGraphBoard(
  container: HTMLElement,
  graph: GraphBlock,
  hooks?: GraphBoardHooks
) {
  validateGraphRecipe(graph);
  const { default: JXG } = await import('jsxgraph');
  const interactive = Boolean(hooks);
  let frame = frameFor(graph.board.bbox);
  const toBoard = ([left, top, right, bottom]: Bbox): Bbox => [
    (left - frame.ox) / frame.unit,
    (top - frame.oy) / frame.unit,
    (right - frame.ox) / frame.unit,
    (bottom - frame.oy) / frame.unit,
  ];
  const boardX = (x: number) => (x - frame.ox) / frame.unit;
  const boardY = (y: number) => (y - frame.oy) / frame.unit;
  const userX = (x: number) => frame.ox + x * frame.unit;
  const userY = (y: number) => frame.oy + y * frame.unit;
  const view = (): Bbox => {
    const [left, top, right, bottom] = board.getBoundingBox();
    return [userX(left), userY(top), userX(right), userY(bottom)];
  };
  const boardOptions: Partial<BoardAttributes> & {
    text: Partial<TextAttributes>;
  } = {
    // Axes and grid are drawn with the elements, in the frame's units.
    axis: false,
    boundingbox: toBoard(graph.board.bbox),
    grid: false,
    // The editor pans by dragging and zooms with its own smooth wheel handler
    // (JSXGraph steps 25% per wheel event); pinches keep both axes in step.
    pan: { enabled: interactive, needShift: false, needTwoFingers: false },
    renderer: 'svg',
    resize: { enabled: false, throttle: 100 },
    showCopyright: false,
    showNavigation: false,
    text: { display: 'internal', parse: false, useMathJax: false },
    zoom: {
      needShift: false,
      pinchHorizontal: false,
      pinchVertical: false,
      wheel: false,
    },
  };
  const board = JXG.JSXGraph.initBoard(container, boardOptions);
  let current = graph;
  let created: GeometryElement[] = [];
  // SVG text never wraps: a long label becomes one tspan per line, each
  // following the label's x when it moves.
  let wrapped: { node: SVGTextElement; lines: string[] }[] = [];
  const layoutLabels = () => {
    for (const { node, lines } of wrapped) {
      if (node.childElementCount !== lines.length) {
        node.textContent = '';
        lines.forEach((line, index) => {
          const span = document.createElementNS(SVG_NS, 'tspan');
          span.textContent = line;
          if (index) span.setAttribute('dy', '1.2em');
          node.append(span);
        });
      }
      const x = node.getAttribute('x');
      if (x) for (const span of node.children) span.setAttribute('x', x);
    }
  };
  board.on('update', layoutLabels);
  /** Tick and grid steps for the current zoom, in the graph's units. */
  const guideSteps = () => [
    tickStep(board.unitX / frame.unit),
    tickStep(board.unitY / frame.unit),
  ];
  let steps = [0, 0];
  /** Axes, grid and elements in the frame's units. */
  const drawAll = () => {
    const points = new Map<string, Point>();
    const [left, top, right, bottom] = board.getBoundingBox();
    // Pixels per board unit; proportional boards have scaleX === scaleY.
    const scaleX = board.unitX;
    const scaleY = board.unitY;
    // Dragged elements land on the board's precision: 0.1 at the default zoom.
    const step = 10 ** Math.floor(Math.log10((10 * frame.unit) / scaleX));
    const snap = (value: number) =>
      Number((Math.round(value / step) * step).toPrecision(12));
    const graph = current;
    const at = ([x, y]: [number, number]) => [boardX(x), boardY(y)];
    // Ticks and grid lines every GeoGebra step, the grid on the numbered ticks.
    const [stepX, stepY] = guideSteps();
    steps = [stepX, stepY];
    if (graph.board.grid)
      board.create('grid', [], {
        majorStep: [stepX / frame.unit, stepY / frame.unit],
        minorElements: 0,
      });
    if (graph.board.axis) {
      const { x, y } = JXG.Options.board.defaultAxes as Record<
        'x' | 'y',
        { ticks: object }
      >;
      const ticks = (
        defaults: { ticks: object },
        tick: number,
        number: (tick: { usrCoords: number[] }) => string
      ) => ({
        ...defaults.ticks,
        drawZero: true,
        generateLabelText: number,
        insertTicks: false,
        majorHeight: 10,
        minorHeight: 5,
        minorTicks: 1,
        ticksDistance: tick / frame.unit,
      });
      // Both axes pass through the true origin, wherever the frame sits; one
      // off the view sticks to the nearer edge with its numbers inside.
      const origin = [boardX(0), boardY(0)];
      // JSXGraph converts a pixel anchorDist with the other axis's scale, so
      // it gets board units.
      const sticky = (inset: number) => ({
        anchor: 'right left',
        anchorDist: inset,
        position: 'sticky',
      });
      const numberWidth = Math.max(
        ...[top, bottom].map((edge) =>
          measureLabel(axisNumber(userY(edge), stepY))
        )
      );
      board.create('axis', [origin, [origin[0] + 1, origin[1]]], {
        ...x,
        ...sticky(24 / scaleY),
        ticks: ticks(x, stepX, (tick) =>
          axisNumber(userX(tick.usrCoords[1]), stepX)
        ),
      });
      board.create('axis', [origin, [origin[0], origin[1] + 1]], {
        ...y,
        ...sticky((numberWidth + 14) / scaleX),
        ticks: ticks(y, stepY, (tick) =>
          axisNumber(userY(tick.usrCoords[2]), stepY)
        ),
      });
    }
    // Point names sit on the side facing away from the figure's centre, so a
    // vertex label lands outside its polygon instead of on an edge.
    const named = graph.elements.filter(
      (element) => element.type === 'point' && element.name && !element.hidden
    ) as Extract<GraphElement, { type: 'point' }>[];
    const centre = named.length
      ? named
          .reduce(
            ([x, y], element) => [x + element.coords[0], y + element.coords[1]],
            [0, 0]
          )
          .map((sum) => sum / named.length)
      : [0, 0];
    const labelPlacement = ([x, y]: [number, number]) => {
      const dx = ((x - centre[0]) * scaleX) / frame.unit;
      const dy = ((y - centre[1]) * scaleY) / frame.unit;
      const length = Math.hypot(dx, dy);
      if (named.length < 3 || length < 1) return { offset: [8, 8] };
      return {
        anchorX: dx >= 0 ? 'left' : 'right',
        anchorY: dy >= 0 ? 'bottom' : 'top',
        offset: [(dx / length) * 8, (dy / length) * 8],
      } as const;
    };
    // Angle marks scale with the board so they read the same at any zoom.
    const angleRadius = Math.min(right - left, top - bottom) * 0.06;
    // A drag that moved reports where it landed; the editor saves it as typed.
    const movable = (
      element: GraphElement & { coords: [number, number] },
      object: {
        X: () => number;
        Y: () => number;
        on: (event: string, handler: () => void) => unknown;
      }
    ) => {
      if (!hooks) return;
      object.on('up', () => {
        const coords: [number, number] = [
          snap(userX(object.X())),
          snap(userY(object.Y())),
        ];
        if (coords[0] !== element.coords[0] || coords[1] !== element.coords[1])
          hooks.onMove(element.id, coords);
      });
    };
    const add = (element: GraphElement) => {
      const attributes = {
        dash: 'dash' in element && element.dash ? 2 : 0,
        fillColor: '#222222',
        fixed: true,
        highlight: false,
        id: element.id,
        shadow: false,
        strokeColor: '#222222',
        visible: !element.hidden,
      };
      switch (element.type) {
        case 'point': {
          const point = board.create('point', at(element.coords), {
            ...attributes,
            fixed: !interactive,
            label: {
              display: 'internal',
              parse: false,
              ...labelPlacement(element.coords),
            },
            name: element.name ?? '',
            size: 2,
          }) as Point;
          points.set(element.id, point);
          movable(element, point);
          break;
        }
        case 'functiongraph': {
          const fn = board.jc.snippet(
            runtimeTerm(element.term),
            true,
            'x',
            false
          );
          const local = (x: number) => boardY(fn(userX(x)));
          board.create(
            'functiongraph',
            element.domain ? [local, ...element.domain.map(boardX)] : [local],
            { ...attributes, fillColor: 'none', fillOpacity: 0 }
          );
          break;
        }
        case 'line':
          board.create(
            'line',
            element.points.map((id) => points.get(id)),
            attributes
          );
          break;
        case 'segment': {
          const segment = board.create(
            'segment',
            element.points.map((id) => points.get(id)),
            attributes
          );
          // Equal sides carry the same number of short marks across their middle.
          if (element.ticks)
            board.create('hatch', [segment, element.ticks], {
              ...attributes,
              dash: 0,
              id: `${element.id}-ticks`,
              majorHeight: 10,
              strokeWidth: 1.5,
              ticksDistance: 5 / Math.min(scaleX, scaleY),
            });
          break;
        }
        case 'circle':
          board.create(
            'circle',
            [points.get(element.center), element.radius / frame.unit],
            {
              ...attributes,
              fillOpacity: 0,
            }
          );
          break;
        case 'text': {
          const label = board.create(
            'text',
            [...at(element.coords), element.text],
            {
              ...attributes,
              display: 'internal',
              fixed: !interactive,
              parse: false,
              useMathJax: false,
            }
          );
          movable(element, label);
          const lines = wrapLabel(element.text, measureLabel);
          if (lines.length > 1)
            wrapped.push({
              lines,
              node: label.rendNode as unknown as SVGTextElement,
            });
          break;
        }
        case 'angle': {
          const [first, vertex, second] = element.points.map(
            (id) => points.get(id) as Point
          );
          board.create('nonreflexangle', [first, vertex, second], {
            ...attributes,
            fillOpacity: 0,
            orthoType: 'square',
            radius: angleRadius,
            withLabel: false,
          });
          if (element.label) {
            // Centre the value on the bisector just beyond the arc, so it sits
            // inside the angle instead of on one of its arms.
            const unit = (to: Point) => {
              const dx = (to.X() - vertex.X()) * scaleX;
              const dy = (to.Y() - vertex.Y()) * scaleY;
              const length = Math.hypot(dx, dy) || 1;
              return [dx / length, dy / length];
            };
            const [ax, ay] = unit(first);
            const [bx, by] = unit(second);
            let [mx, my] = [ax + bx, ay + by];
            if (Math.hypot(mx, my) < 1e-6) [mx, my] = [-ay, ax];
            const length = Math.hypot(mx, my);
            // Narrow angles push the value out until the wedge fits about two
            // characters (13px either side of the bisector), up to 70px.
            const half =
              Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by))) / 2;
            const distance = Math.min(
              70,
              Math.max(
                angleRadius * 1.9 * scaleX,
                13 / Math.tan(Math.max(half, 0.05))
              )
            );
            board.create(
              'text',
              [
                vertex.X() + ((mx / length) * distance) / scaleX,
                vertex.Y() + ((my / length) * distance) / scaleY,
                element.label,
              ],
              {
                ...attributes,
                anchorX: 'middle',
                anchorY: 'middle',
                display: 'internal',
                id: `${element.id}-label`,
                parse: false,
                useMathJax: false,
              }
            );
          }
          break;
        }
        case 'arc':
        case 'sector':
          board.create(
            element.type,
            [
              points.get(element.center),
              ...element.points.map((id) => points.get(id)),
            ],
            {
              ...attributes,
              fillOpacity:
                element.type === 'sector' && element.shade ? 0.15 : 0,
            }
          );
          break;
        case 'polygon':
          board.create(
            'polygon',
            element.points.map((id) => points.get(id)),
            {
              ...attributes,
              // Borders default to half the width of segments; match them.
              borders: {
                dash: attributes.dash,
                fixed: true,
                highlight: false,
                strokeColor: '#222222',
                strokeWidth: 2,
                visible: attributes.visible,
              },
              fillOpacity: element.shade ? 0.15 : 0,
              hasInnerPoints: false,
              vertices: { visible: false },
            }
          );
          break;
      }
    };
    graph.elements.filter((element) => element.type === 'point').forEach(add);
    graph.elements.filter((element) => element.type !== 'point').forEach(add);
  };
  const draw = () => {
    const before = board.objectsList.length;
    wrapped = [];
    board.suspendUpdate();
    try {
      drawAll();
    } finally {
      created = board.objectsList.slice(before) as GeometryElement[];
      board.unsuspendUpdate();
    }
    layoutLabels();
  };
  /**
   * Shows `bbox` in a frame that suits it, everything redrawn. The board is
   * cleared first: a grid spaced for the old view would draw millions of
   * lines across a far larger one.
   */
  let jumping = false;
  const jump = (bbox: Bbox) => {
    clear();
    frame = frameFor(bbox);
    jumping = true;
    try {
      board.setBoundingBox(toBoard(bbox), false);
    } finally {
      jumping = false;
    }
    draw();
  };
  const clear = () => {
    board.suspendUpdate();
    // Children (labels, hatches) may already be gone with their parent.
    for (const object of [...created].reverse())
      if (board.objects[object.id]) board.removeObject(object);
    created = [];
    board.unsuspendUpdate();
  };
  try {
    draw();
    board.fullUpdate();
  } catch (error) {
    JXG.JSXGraph.freeBoard(board);
    throw error;
  }
  // Ticks and grid follow a zoom as it happens, in a frame that suits the view.
  board.on('boundingbox', () => {
    const [stepX, stepY] = guideSteps();
    if (!jumping && (stepX !== steps[0] || stepY !== steps[1])) jump(view());
  });
  const cleanups: (() => void)[] = [];
  if (hooks) {
    let scale = board.unitX / frame.unit;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // The editor hears about the view once a pan or zoom settles: reporting
    // every step re-rendered the whole dialog per wheel event.
    board.on('boundingbox', () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const bbox = view();
        if (!sameBox(bbox, current.board.bbox)) hooks.onBoundingBox(bbox);
        // Angle marks, hatches and label offsets are sized in pixels; a pan
        // that drifted from the frame gets a new one.
        const next = frameFor(bbox);
        const drifted =
          next.ox !== frame.ox ||
          next.oy !== frame.oy ||
          next.unit !== frame.unit;
        if (!drifted && board.unitX / frame.unit === scale) return;
        jump(bbox);
        scale = board.unitX / frame.unit;
      }, 150);
    });
    // Trackpads send wheel events faster than the screen refreshes; zoom
    // once per frame by their combined factor, like Desmos.
    let factor = 1;
    let anchor: [number, number] = [0, 0];
    let pending = 0;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const lines = event.deltaMode === 1 ? 16 : 1;
      // Trackpad pinches arrive as ctrl+wheel with small deltas.
      const rate = event.ctrlKey ? 0.01 : 0.002;
      factor *= Math.exp(-event.deltaY * lines * rate);
      anchor = board.getMousePosition(event) as [number, number];
      pending ||= requestAnimationFrame(() => {
        pending = 0;
        const [, x, y] = new JXG.Coords(JXG.COORDS_BY_SCREEN, anchor, board)
          .usrCoords;
        zoom(factor, x, y);
        factor = 1;
      });
    };
    const doubleClick = (event: MouseEvent) => {
      const [, x, y] = new JXG.Coords(
        JXG.COORDS_BY_SCREEN,
        board.getMousePosition(event),
        board
      ).usrCoords;
      zoom(2, x, y);
    };
    container.addEventListener('wheel', wheel, { passive: false });
    container.addEventListener('dblclick', doubleClick);
    cleanups.push(() => {
      clearTimeout(settle);
      cancelAnimationFrame(pending);
      container.removeEventListener('wheel', wheel);
      container.removeEventListener('dblclick', doubleClick);
    });
  }
  /** Zooms by `factor` (above 1 zooms in) keeping (x, y) under the pointer. */
  function zoom(factor: number, x?: number, y?: number) {
    const [l, t, r, b] = board.getBoundingBox();
    const cx = x ?? (l + r) / 2;
    const cy = y ?? (t + b) / 2;
    const scale = (board.unitX * factor) / frame.unit;
    if (scale < SCALE_MIN || scale > SCALE_MAX) return;
    board.setBoundingBox(
      [
        cx - (cx - l) / factor,
        cy + (t - cy) / factor,
        cx + (r - cx) / factor,
        cy - (cy - b) / factor,
      ],
      false
    );
  }
  return {
    destroy() {
      for (const cleanup of cleanups) cleanup();
      JXG.JSXGraph.freeBoard(board);
    },
    exportSvg() {
      const original = container.querySelector('svg');
      if (!original)
        throw new GraphError(m.question_ui_the_graph_could_not_be_exported());
      const svg = original.cloneNode(true) as SVGSVGElement;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', String(current.width));
      svg.setAttribute('height', String(current.height));
      svg.setAttribute('viewBox', `0 0 ${current.width} ${current.height}`);
      svg.style.fontFamily = 'Arial, sans-serif';
      svg.querySelectorAll('foreignObject,script,filter').forEach((node) => {
        node.remove();
      });
      svg.querySelectorAll('[filter]').forEach((node) => {
        node.removeAttribute('filter');
      });
      svg.querySelectorAll<SVGElement>('[style]').forEach((node) => {
        node.style.removeProperty('filter');
      });
      // JSXGraph's board IDs vary between sessions; keep identical recipes hashable.
      const elements = [svg, ...svg.querySelectorAll('*')];
      const ids = new Map(
        elements
          .filter((node) => node.id)
          .map((node, index) => [node.id, `graph-${index}`])
      );
      for (const node of elements) {
        for (const attribute of Array.from(node.attributes)) {
          let value = attribute.value;
          if (attribute.name === 'id') value = ids.get(value) ?? value;
          else if (value.startsWith('#') && ids.has(value.slice(1)))
            value = `#${ids.get(value.slice(1))}`;
          else
            value = value.replace(
              LOCAL_SVG_URL,
              (match, _quote: string, id: string) =>
                ids.has(id) ? `url(#${ids.get(id)})` : match
            );
          if (value !== attribute.value)
            node.setAttribute(attribute.name, value);
        }
      }
      return new XMLSerializer().serializeToString(svg);
    },
    /** Frames every element, keeping the current units ratio. */
    fit() {
      const box = figureBounds(current, view(), (term) =>
        board.jc.snippet(runtimeTerm(term), true, 'x', false)
      );
      if (!box) return;
      const [l, t, r, b] = box;
      // Grow the short side so x and y units keep their current ratio.
      const ratio = board.unitX / board.unitY;
      const width = Math.max(
        r - l,
        ((t - b) * board.canvasWidth) / board.canvasHeight / ratio
      );
      const height = (width * ratio * board.canvasHeight) / board.canvasWidth;
      const cx = (l + r) / 2;
      const cy = (t + b) / 2;
      jump([cx - width / 2, cy + height / 2, cx + width / 2, cy - height / 2]);
    },
    /** Redraws for a changed recipe; the board itself stays. */
    update(next: GraphBlock) {
      validateGraphRecipe(next);
      const previous = current;
      current = next;
      // Only a bbox typed elsewhere moves the board; one the board reported
      // itself may arrive late, mid-pan, or match where it already is.
      if (
        !sameBox(next.board.bbox, previous.board.bbox) &&
        !sameBox(next.board.bbox, view())
      )
        jump(next.board.bbox);
      else if (
        JSON.stringify(previous.elements) !== JSON.stringify(next.elements) ||
        previous.board.axis !== next.board.axis ||
        previous.board.grid !== next.board.grid
      ) {
        clear();
        draw();
      }
    },
    zoom,
  };
}

/** The area every element occupies with a 10% margin, or null when nothing
 * has a position. Functions count over the points' x range, or the current
 * view's when there are no points. */
function figureBounds(
  graph: GraphBlock,
  view: number[],
  compile: (term: string) => (x: number) => number
): GraphBlock['board']['bbox'] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const byId = new Map(graph.elements.map((element) => [element.id, element]));
  for (const element of graph.elements) {
    if (element.type === 'point' || element.type === 'text') {
      xs.push(element.coords[0]);
      ys.push(element.coords[1]);
    }
    if (element.type === 'circle') {
      const center = byId.get(element.center);
      if (center?.type === 'point') {
        xs.push(
          center.coords[0] - element.radius,
          center.coords[0] + element.radius
        );
        ys.push(
          center.coords[1] - element.radius,
          center.coords[1] + element.radius
        );
      }
    }
    if (element.type === 'functiongraph' && element.domain)
      xs.push(...element.domain);
  }
  const [from, to] = xs.length
    ? [Math.min(...xs), Math.max(...xs)]
    : [view[0], view[2]];
  for (const element of graph.elements) {
    if (element.type !== 'functiongraph') continue;
    const [lo, hi] = element.domain ?? [from, to];
    const fn = compile(element.term);
    for (let i = 0; i <= 100; i++) {
      const y = fn(lo + ((hi - lo) * i) / 100);
      if (Number.isFinite(y) && Math.abs(y) < 1e6) ys.push(y);
    }
    xs.push(lo, hi);
  }
  if (!xs.length || !ys.length) return null;
  const [l, r, b, t] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const padX = Math.max(r - l, 1) * 0.1;
  const padY = Math.max(t - b, 1) * 0.1;
  return [l - padX, t + padY, r + padX, b - padY];
}

export async function renderGraphSvg(
  container: HTMLElement,
  graph: GraphBlock
): Promise<string> {
  container.style.width = `${graph.width}px`;
  container.style.height = `${graph.height}px`;
  const board = await createGraphBoard(container, graph);
  try {
    return board.exportSvg();
  } finally {
    board.destroy();
  }
}
