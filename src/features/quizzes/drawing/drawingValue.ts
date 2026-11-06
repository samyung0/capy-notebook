import { createContext } from 'react';
import type { Answer, Answers } from '../grade';

/** A drawing part's answer on this device, from its last Done: the board's
 * saved document and its marking image (a data URL), and once an assignment
 * stored it, the drawing's id. */
export type DrawingValue = { board: string; drawing?: string; image: string };

export function isDrawingValue(value: Answer): value is DrawingValue {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.board === 'string' &&
    typeof value.image === 'string'
  );
}

/** Epo's cap on a saved board (2026-11-06), undo history stripped first. */
export const DRAWING_BOARD_MAX = 250 * 1024;

/** Where a page's drawing answers are, so a board being drawn is kept on the
 * device under it until Done: the attempt or the quiz. None keeps no drafts. */
export const DrawingDraftScope = createContext<string | null>(null);

export const drawingDraftKey = (scope: string, partId: string) =>
  `${scope}:${partId}`;

/** Stores a drawing part's board with Done and returns its id, or with null
 * (Done on an emptied board) forgets it: an assignment's, whose attempt is on
 * the server from the start. Practice has none, so its drawings stay on the
 * device until Check sends them (Epo 2026-11-06). */
export const DrawingUploader = createContext<
  | ((partId: string, value: DrawingValue | null) => Promise<string | null>)
  | null
>(null);

const DATA_URL_PREFIX = /^data:[^;,]+;base64,/;

/** A drawing as a check sends it: the board and the image in base64. */
export const drawingUpload = (value: DrawingValue) => ({
  board: value.board,
  image: value.image.replace(DATA_URL_PREFIX, ''),
});

/** The answers a check sends: each drawing as its board and image. */
export const answersForCheck = (answers: Answers): Answers =>
  Object.fromEntries(
    Object.entries(answers).map(([part, value]) => [
      part,
      isDrawingValue(value) ? drawingUpload(value) : value,
    ])
  );

/** The answers an assignment saves: each drawing by the id Done stored it
 * under, and one not stored yet left out. */
export const answersForSave = (answers: Answers): Answers =>
  Object.fromEntries(
    Object.entries(answers).flatMap(([part, value]) =>
      isDrawingValue(value)
        ? value.drawing
          ? [[part, { drawing: value.drawing }]]
          : []
        : [[part, value]]
    )
  );

/** The board open to answer on, at most one at a time: a time limit running
 * out submits it as it stands (Epo 2026-11-06). */
let openBoard: (() => Promise<void>) | null = null;

export function holdOpenDrawing(finish: () => Promise<void>) {
  openBoard = finish;
  return () => {
    if (openBoard === finish) openBoard = null;
  };
}

/** Presses Done on the open board, if any, and waits for its answer. */
export async function finishOpenDrawing() {
  await openBoard?.();
}
