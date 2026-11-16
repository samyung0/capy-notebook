import * as limits from '@/api/limits.generated';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import type { GraphBlock } from './types';
import { validGraphTerm } from './validation';

/** A graph that cannot be drawn; its message is localized copy. */
export class GraphError extends CopyError {}

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
