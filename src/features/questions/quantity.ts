/* Kept apart from validation.ts so grading on public pages loads no zod. */

/** Values only. A quantity's unit belongs to the question, never to its answer. */
export const quantityValuePattern =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:\s*\/\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)?$/;
