import type { BoardAttributes, Point, TextAttributes } from 'jsxgraph';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
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

export async function createGraphBoard(
  container: HTMLElement,
  graph: GraphBlock
) {
  validateGraphRecipe(graph);
  const { default: JXG } = await import('jsxgraph');
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
    pan: { enabled: false },
    renderer: 'svg',
    resize: { enabled: false, throttle: 100 },
    showCopyright: false,
    showNavigation: false,
    text: { display: 'internal', parse: false, useMathJax: false },
    zoom: { pinchHorizontal: false, pinchVertical: false, wheel: false },
  };
  const board = JXG.JSXGraph.initBoard(container, boardOptions);
  const points = new Map<string, Point>();
  const [left, top, right, bottom] = graph.board.bbox;
  // Pixels per board unit; proportional boards have scaleX === scaleY.
  const scaleX = graph.width / (right - left);
  const scaleY = graph.height / (top - bottom);
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
      case 'point':
        points.set(
          element.id,
          board.create('point', element.coords, {
            ...attributes,
            label: {
              display: 'internal',
              parse: false,
              ...labelPlacement(element.coords),
            },
            name: element.name ?? '',
            size: 2,
          })
        );
        break;
      case 'functiongraph': {
        const fn = board.jc.snippet(element.term, true, 'x', false);
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
        board.create('text', [...element.coords, element.text], {
          ...attributes,
          display: 'internal',
          parse: false,
          useMathJax: false,
        });
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
            fillOpacity: element.type === 'sector' && element.shade ? 0.15 : 0,
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
  try {
    graph.elements.filter((element) => element.type === 'point').forEach(add);
    graph.elements.filter((element) => element.type !== 'point').forEach(add);
    board.fullUpdate();
  } catch (error) {
    JXG.JSXGraph.freeBoard(board);
    throw error;
  }
  return {
    destroy() {
      JXG.JSXGraph.freeBoard(board);
    },
    exportSvg() {
      const original = container.querySelector('svg');
      if (!original)
        throw new GraphError(m.question_ui_the_graph_could_not_be_exported());
      const svg = original.cloneNode(true) as SVGSVGElement;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', String(graph.width));
      svg.setAttribute('height', String(graph.height));
      svg.setAttribute('viewBox', `0 0 ${graph.width} ${graph.height}`);
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
  };
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
