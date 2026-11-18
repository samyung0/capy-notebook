import * as limits from '@/api/limits.generated';
import { m } from '@/i18n';
import { CopyError } from '@/lib/copyError';
import type { GraphBlock } from './types';
import {
  type GraphElementsIssue,
  graphElementSchema,
  graphElementsIssue,
} from './validation';

/** A graph that cannot be drawn; its message is localized copy. */
export class GraphError extends CopyError {}

/** The editor's words for what an element's own check refuses, by field. */
const fieldMessages: Record<string, () => string> = {
  center: m.question_ui_enter_valid_coordinates,
  coords: m.question_ui_enter_valid_coordinates,
  handles: m.question_ui_enter_valid_coordinates,
  id: m.question_ui_graph_elements_need_unique_identifiers,
  radii: m.question_ui_enter_valid_coordinates,
  radius: m.question_ui_select_a_center_and_a_positive_radius,
};
const issueMessages = {
  center: m.question_ui_select_a_center_point,
  ids: m.question_ui_graph_elements_need_unique_identifiers,
  points: m.question_ui_select_different_points,
} satisfies Record<GraphElementsIssue, () => string>;

/** The graph dialog's check, in its own words: bounds and size, the element
 * cap, then the checks every surface runs (`graphElementSchema` on each
 * element, `graphElementsIssue` across them). */
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
      m.question_ui_graph_elements_max({
        max: limits.QUESTION_GRAPH_ELEMENTS_MAX,
      })
    );
  for (const element of graph.elements) {
    const parsed = graphElementSchema.safeParse(element);
    if (parsed.success) continue;
    const [issue] = parsed.error.issues;
    const field = fieldMessages[String(issue.path[0])];
    throw new GraphError(field ? field() : issue.message);
  }
  const issue = graphElementsIssue(graph.elements);
  if (issue) throw new GraphError(issueMessages[issue]());
}
