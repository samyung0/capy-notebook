import { createContext } from 'react';
import type { Answer } from '../grade';

/** A drawing part's answer on this device, from its last Done: the board's
 * saved document and its marking image (a data URL). */
export type DrawingValue = { board: string; image: string };

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
