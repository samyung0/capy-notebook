import {
  fullPartLabel,
  partPlaces,
  subLabel,
} from '@/features/questions/groups';
import type { BlockSection } from '@/features/questions/QuestionView';
import {
  type CanvasPlace,
  type LearnerPart,
  type LearnerQuestion,
  partAnswerCanvas,
  type Question,
  type QuestionPart,
} from '@/features/questions/types';
import { deleteLocalDrawingDraft } from '@/lib/localDb';
import type { Answer, Answers } from '../grade';
import { storedDrawingId } from './DrawingPreview';
import { drawingDraftKey, isDrawingValue } from './drawingValue';

type AnyQuestion = Question | LearnerQuestion;
type AnyPart = QuestionPart | LearnerPart;

/**
 * Each canvas part's drawing part (Epo 2026-11-23): the part whose answer
 * holds the drawing it is answered with, itself on its own canvas, or,
 * answered in the canvas above (`shared`), the first part in question order
 * answering in that same canvas. The parts sharing a canvas share one
 * drawing, kept and stored once under that part, and each is graded on it. A
 * canvas part whose canvas is missing (the validators refuse it) is absent.
 * Go's `questions.DrawingParts` is the same.
 */
export function drawingParts(question: AnyQuestion): Map<string, string> {
  const out = new Map<string, string>();
  const first = new Map<string, string>();
  for (const part of question.parts) {
    const canvas = partAnswerCanvas(question, part);
    if (!canvas) continue;
    const key = canvasKey(canvas.place);
    if (!first.has(key)) first.set(key, part.id);
    out.set(part.id, first.get(key) ?? part.id);
  }
  return out;
}

/** A canvas named by where it sits: one canvas a list, so where it sits
 * names it, across edits of its question too (Epo 2026-11-24). */
const canvasKey = (place: CanvasPlace) =>
  place.section === 'stem'
    ? 'stem'
    : place.section === 'group'
      ? `group:${place.groupId}`
      : `part:${place.partId}`;

/** A canvas's name in its quiz, its question's id and where it sits (a
 * place, or `drawingCanvases`' name for it): what
 * its device draft and its open board are kept under, so a change of the part
 * its drawing is kept under changes neither (Epo 2026-11-24). */
export const canvasName = (
  question: AnyQuestion,
  place: CanvasPlace | string
) => `${question.id}:${typeof place === 'string' ? place : canvasKey(place)}`;

/** Each drawing part of `question` (`drawingParts`' values) by the canvas its
 * drawing is drawn in (`canvasKey`), which an edit's drawing follows
 * (`drawingMoves`). Go's `questions.DrawingCanvases` is the same. */
export function drawingCanvases(question: AnyQuestion): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const part of question.parts) {
    const canvas = partAnswerCanvas(question, part);
    if (!canvas || seen.has(canvasKey(canvas.place))) continue;
    seen.add(canvasKey(canvas.place));
    out.set(part.id, canvasKey(canvas.place));
  }
  return out;
}

/** The group canvases an edit handed to a part (Ungroup, or removing a
 * group's sub-parts down to one): a group gone from `after` whose first
 * sub-part, holding no canvas of its own before, now answers on one of its
 * own, by `canvasKey`, the group's to the part's. The drawing in it follows
 * it. Go's `questions.UngroupedCanvases` is the same. */
export function ungroupedCanvases(
  before: AnyQuestion,
  after: AnyQuestion
): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of before.groups ?? []) {
    if (after.groups?.some(({ id }) => id === group.id)) continue;
    const first = (before.parts as AnyPart[]).find(
      (part) => part.group === group.id
    );
    const now = (after.parts as AnyPart[]).find(({ id }) => id === first?.id);
    if (!(first && now) || first.blocks.some(({ type }) => type === 'canvas'))
      continue;
    if (partAnswerCanvas(after, now)?.place.section === 'part')
      out.set(
        canvasKey({ groupId: group.id, section: 'group' }),
        canvasKey({ partId: now.id, section: 'part' })
      );
  }
  return out;
}

/** The parts answering in the canvas at `index` of the stem's blocks or a
 * group's (`section`), in question order: none for a canvas only looked at,
 * or one in a part's blocks. */
export function sharingParts(
  question: AnyQuestion,
  section: BlockSection,
  index: number
): AnyPart[] {
  if (section.partId !== undefined || section.solution) return [];
  return (question.parts as AnyPart[]).filter((part) => {
    const canvas = partAnswerCanvas(question, part);
    if (canvas?.index !== index) return false;
    return section.groupId === undefined
      ? canvas.place.section === 'stem'
      : canvas.place.section === 'group' &&
          canvas.place.groupId === section.groupId;
  });
}

/** The id a part's answer is kept under: a part answered in the canvas above
 * reads its drawing part's. */
export const answerId = (question: AnyQuestion, part: AnyPart) =>
  drawingParts(question).get(part.id) ?? part.id;

/** A part's answer as a run or an attempt keeps it, by part id: a part
 * answered in the canvas above reads its drawing part's. */
export const partAnswer = <T>(
  question: AnyQuestion,
  answers: Record<string, T>,
  part: AnyPart
): T | undefined => answers[answerId(question, part)];

/** Whether a canvas answer holds a drawing: drawn on this device, or stored. */
export const drawingAnswered = (value: Answer | undefined) =>
  value !== undefined && (isDrawingValue(value) || !!storedDrawingId(value));

/** The labels the parts answering in one canvas show beside them, for its
 * hint: a group's sub-parts by their sub-labels ("(i)"), any other by its
 * full label ("(a)", "(b)(i)", "2"). */
export function sharingLabels(
  question: AnyQuestion,
  parts: AnyPart[],
  section: BlockSection
): string[] {
  const places = partPlaces(question);
  return parts.map((part) => {
    const sub = places.get(part.id)?.sub;
    return section.groupId !== undefined && sub !== undefined
      ? subLabel(sub)
      : fullPartLabel(question, part.id).replace(TRAILING_DOT, '');
  });
}

const TRAILING_DOT = /\.$/;

/** Forgets the device drafts of the canvases whose drawings a check of
 * `question` sent (`answers`, by drawing part): they are on the server. */
export function forgetDrawingDrafts(
  scope: string,
  question: AnyQuestion,
  answers: Answers
) {
  for (const [part, canvas] of drawingCanvases(question))
    if (isDrawingValue(answers[part] ?? null))
      deleteLocalDrawingDraft(
        drawingDraftKey(scope, canvasName(question, canvas))
      ).catch(() => undefined);
}
