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

/** Whether a graph's tools and rows add no more: at the element cap, or past it
 * on a canvas plane two adds at the same moment merged past it (Epo 2026-11-22). */
export const graphFull = (count: number) =>
  count >= limits.QUESTION_GRAPH_ELEMENTS_MAX;

/** How many of a graph's elements its readers draw, so how many of its existing
 * rows the editor writes: every one on a canvas plane, whose load check takes
 * twice the cap (Epo 2026-11-22); the cap on a quiz or note graph, as the Rust
 * and Go validators refuse more and the read repairs keep its first ones. */
export const drawnMaxFor = (canvasPlane: boolean) =>
  canvasPlane ? Number.POSITIVE_INFINITY : limits.QUESTION_GRAPH_ELEMENTS_MAX;

/** The graph dialog's check, in its own words: bounds and size, at most
 * `drawnMax` elements (the cap on a quiz or note graph, whose readers keep its
 * first ones; every one on a canvas plane), then the checks every surface runs
 * (`graphElementSchema` on each element, `graphElementsIssue` across them). */
export function validateGraphRecipe(graph: GraphBlock, drawnMax: number): void {
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
  if (graph.elements.length > drawnMax)
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
