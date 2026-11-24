import type {
  LearnerPart,
  LearnerQuestion,
  Question,
  QuestionPart,
} from '@/features/questions/types';
import {
  canvasName,
  drawingCanvases,
  ungroupedCanvases,
} from './drawing/canvasParts';
import type { Answer } from './grade';

type AnyQuestion = LearnerQuestion | Question;
type AnyPart = LearnerPart | QuestionPart;

/** Whether an answer still means what the learner chose after an editor
 * changed the part live (D9, Epo 2026-10-10): a chosen option, ordering item
 * or matching option that is gone, or a changed number of gaps, drops it. A
 * canvas answer follows its canvas instead (`drawingMoves`). */
function stillAnswers(before: AnyPart, after: AnyPart, value: Answer): boolean {
  const a = before.answer;
  const b = after.answer;
  if (a.type !== b.type) return false;
  if (a.type === 'mcq' && 'options' in b)
    return (
      Array.isArray(value) &&
      value.every(
        (i) =>
          typeof i === 'number' &&
          'options' in a &&
          a.options[i] === b.options[i]
      )
    );
  if (a.type === 'ordering' && 'items' in a && 'items' in b)
    return (
      [...a.items].sort().join('\u0000') === [...b.items].sort().join('\u0000')
    );
  if (
    b.type === 'matching' &&
    'options' in b &&
    value &&
    typeof value === 'object'
  )
    return Object.values(value).every((option) =>
      b.options.includes(option as string)
    );
  if (a.type === 'gaps' && b.type === 'gaps')
    return JSON.stringify(a) === JSON.stringify(b);
  return true;
}

const partsById = (questions: readonly AnyQuestion[]) =>
  new Map<string, AnyPart>(
    questions.flatMap((question) =>
      (question.parts as AnyPart[]).map((part) => [part.id, part] as const)
    )
  );

/** Where each drawing goes when the questions change under the learner (Epo
 * 2026-11-24): a canvas is named by its question and where it sits (a group's
 * handed to its sub-part, as its own), and the drawing kept under its first
 * answering part goes to the first part answering in it now, or is dropped
 * (null) when none does. Drawing parts that stay are left out. Go's
 * `drawingTargets` is the same. */
export function drawingMoves(
  before: readonly AnyQuestion[],
  after: readonly AnyQuestion[]
): Map<string, string | null> {
  const leads = new Map<string, string>();
  for (const question of after)
    for (const [part, canvas] of drawingCanvases(question))
      leads.set(`${question.id}\u0000${canvas}`, part);
  const now = new Map(after.map((question) => [question.id, question]));
  const moves = new Map<string, string | null>();
  for (const question of before) {
    const next = now.get(question.id);
    const renamed = next
      ? ungroupedCanvases(question, next)
      : new Map<string, string>();
    for (const [part, canvas] of drawingCanvases(question)) {
      const name = renamed.get(canvas) ?? canvas;
      const lead = leads.get(`${question.id}\u0000${name}`) ?? null;
      if (lead !== part) moves.set(part, lead);
    }
  }
  return moves;
}

/** The canvases an edit gave a new name (`ungroupedCanvases`), as `canvasName`
 * reads them before and after: their device drafts are copied across. */
export function renamedDrafts(
  before: readonly AnyQuestion[],
  after: readonly AnyQuestion[]
): [from: string, to: string][] {
  const now = new Map(after.map((question) => [question.id, question]));
  return before.flatMap((question) => {
    const next = now.get(question.id);
    if (!next) return [];
    return [...ungroupedCanvases(question, next)].map(
      ([from, to]): [string, string] => [
        canvasName(question, from),
        canvasName(next, to),
      ]
    );
  });
}

/** The answers that still mean what the learner chose, each drawing under
 * the part its canvas's drawing is kept under now (`drawingMoves`); `current`
 * itself when nothing changed. */
export function keptAnswers(
  before: readonly AnyQuestion[],
  after: readonly AnyQuestion[],
  current: Record<string, Answer>
) {
  const moves = drawingMoves(before, after);
  const was = partsById(before);
  const now = partsById(after);
  const drawn = new Set(before.flatMap((q) => [...drawingCanvases(q).keys()]));
  const kept: Record<string, Answer> = {};
  const moved: Record<string, Answer> = {};
  let changed = false;
  for (const [id, value] of Object.entries(current)) {
    const a = was.get(id);
    const b = now.get(id);
    if (a?.answer.type === 'canvas') {
      // Only a drawing part holds one: it stays, moves or goes.
      const to = drawn.has(id) ? (moves.has(id) ? moves.get(id) : id) : null;
      if (to) moved[to] = value;
      changed ||= to !== id;
    } else if (a && b && stillAnswers(a, b, value)) kept[id] = value;
    else changed = true;
  }
  return changed ? { ...kept, ...moved } : current;
}
