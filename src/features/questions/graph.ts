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
      (element.type === 'line' || element.type === 'segment') &&
      (element.points[0] === element.points[1] ||
        element.points.some((id) => !points.has(id)))
    )
      throw new GraphError(
        m.question_ui_select_two_different_points_for_the_line()
      );
    if (
      element.type === 'circle' &&
      (!points.has(element.center) ||
        !Number.isFinite(element.radius) ||
        element.radius <= 0)
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
            label: { display: 'internal', parse: false },
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
      case 'segment':
        board.create(
          element.type,
          element.points.map((id) => points.get(id)),
          attributes
        );
        break;
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
