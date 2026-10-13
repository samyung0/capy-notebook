import type {
  BoardAttributes,
  GeometryElement,
  Point,
  TextAttributes,
} from 'jsxgraph';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import { runtimeTerm } from './graphSyntax';
import type { GraphBlock, GraphElement } from './types';
import { validGraphTerm } from './validation';

/** A graph that cannot be drawn; its message is localized copy. */
export class GraphError extends CopyError {}

const LOCAL_SVG_URL = /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g;

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
    graph.width <= 0 ||
    graph.height <= 0
  )
    throw new GraphError(
      m.question_ui_enter_valid_graph_bounds_and_dimensions()
    );
  if (graph.elements.length > 60)
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

export async function createGraphBoard(
  container: HTMLElement,
  graph: GraphBlock,
  hooks?: GraphBoardHooks
) {
  validateGraphRecipe(graph);
  const { default: JXG } = await import('jsxgraph');
  const interactive = Boolean(hooks);
  const boardOptions: Partial<BoardAttributes> & {
    text: Partial<TextAttributes>;
  } = {
    axis: graph.board.axis,
    boundingbox: graph.board.bbox,
    // Default axis ticks span the board (majorHeight -1), drawing a faint
    // grid; without a grid they stay short marks on the axes.
    ...(!graph.board.grid && {
      defaultAxes: {
        x: { ticks: { majorHeight: 10 } },
        y: { ticks: { majorHeight: 10 } },
      },
    }),
    grid: graph.board.grid,
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
  const draw = () => {
    const points = new Map<string, Point>();
    const [left, top, right, bottom] = board.getBoundingBox();
    // Pixels per board unit; proportional boards have scaleX === scaleY.
    const scaleX = board.unitX;
    const scaleY = board.unitY;
    // Dragged elements land on the board's precision: 0.1 at the default zoom.
    const step = 10 ** Math.floor(Math.log10(10 / scaleX));
    const snap = (value: number) =>
      Number((Math.round(value / step) * step).toPrecision(12));
    const graph = current;
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
      const dx = (x - centre[0]) * scaleX;
      const dy = (y - centre[1]) * scaleY;
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
        const coords: [number, number] = [snap(object.X()), snap(object.Y())];
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
          const point = board.create('point', element.coords, {
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
          board.create(
            'functiongraph',
            element.domain ? [fn, ...element.domain] : [fn],
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
          board.create('circle', [points.get(element.center), element.radius], {
            ...attributes,
            fillOpacity: 0,
          });
          break;
        case 'text':
          movable(
            element,
            board.create('text', [...element.coords, element.text], {
              ...attributes,
              display: 'internal',
              fixed: !interactive,
              parse: false,
              useMathJax: false,
            })
          );
          break;
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
    const before = board.objectsList.length;
    board.suspendUpdate();
    try {
      graph.elements.filter((element) => element.type === 'point').forEach(add);
      graph.elements.filter((element) => element.type !== 'point').forEach(add);
    } finally {
      created = board.objectsList.slice(before) as GeometryElement[];
      board.unsuspendUpdate();
    }
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
  const cleanups: (() => void)[] = [];
  if (hooks) {
    let scale = board.unitX;
    let settle: ReturnType<typeof setTimeout> | undefined;
    board.on('boundingbox', () => {
      const bbox = board.getBoundingBox() as GraphBlock['board']['bbox'];
      if (!sameBox(bbox, current.board.bbox)) hooks.onBoundingBox(bbox);
      // Angle marks, hatches and label offsets are sized in pixels; redraw
      // them once a zoom settles.
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (board.unitX === scale) return;
        scale = board.unitX;
        clear();
        draw();
      }, 150);
    });
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const lines = event.deltaMode === 1 ? 16 : 1;
      // Trackpad pinches arrive as ctrl+wheel with small deltas.
      const rate = event.ctrlKey ? 0.01 : 0.002;
      const [, x, y] = new JXG.Coords(
        JXG.COORDS_BY_SCREEN,
        board.getMousePosition(event),
        board
      ).usrCoords;
      zoom(Math.exp(-event.deltaY * lines * rate), x, y);
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
      container.removeEventListener('wheel', wheel);
      container.removeEventListener('dblclick', doubleClick);
    });
  }
  /** Zooms by `factor` (above 1 zooms in) keeping (x, y) under the pointer. */
  function zoom(factor: number, x?: number, y?: number) {
    const [l, t, r, b] = board.getBoundingBox();
    const cx = x ?? (l + r) / 2;
    const cy = y ?? (t + b) / 2;
    const width = (r - l) / factor;
    if (width < 1e-4 || width > 1e6) return;
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
      const box = figureBounds(current, board.getBoundingBox(), (term) =>
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
      board.setBoundingBox(
        [cx - width / 2, cy + height / 2, cx + width / 2, cy - height / 2],
        false
      );
    },
    /** Redraws for a changed recipe; the board itself stays. */
    update(next: GraphBlock) {
      validateGraphRecipe(next);
      const previous = current;
      current = next;
      // Only a bbox typed elsewhere moves the board; one the board reported
      // itself may arrive late, mid-pan.
      if (!sameBox(next.board.bbox, previous.board.bbox))
        board.setBoundingBox(next.board.bbox, false);
      if (JSON.stringify(previous.elements) !== JSON.stringify(next.elements)) {
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
