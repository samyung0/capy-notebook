import { createContext } from 'react';
import { BOARD_CATALOG } from '@/api/board.generated';
import { toBase64 } from '@/features/blocksuite/base64';
import { deleteLocalDrawingDraft } from '@/lib/localDb';
import type { Answer, Answers } from '../grade';

/** A drawing part's answer on this device, from its last Done: the board's
 * saved document and its marking image (a data URL), and once an assignment
 * stored it, the drawing's id. `pictures` names the board's pasted pictures in
 * this page's memory (`heldDrawingPictures`): files don't sit in an answer. */
export type DrawingValue = {
  board: string;
  drawing?: string;
  image: string;
  pictures?: string;
};

/** A picture pasted on an answer board, by the id its image block names. */
export type DrawingPicture = { file: Blob; id: string };

/** An answer board's pictures: each at most this many bytes after the
 * browser's compression, and at most this many (Epo 2026-11-09). */
export const BOARD_IMAGE_MAX = BOARD_CATALOG.limits.BOARD_IMAGE_MAX;
export const BOARD_IMAGES_MAX = BOARD_CATALOG.limits.BOARD_IMAGES_MAX;

/** The pictures of each part's last Done, until its check or store sends them. */
const pictures = new Map<string, DrawingPicture[]>();

/** Keeps a Done's pictures under `key` (the part's draft key, or any other
 * that is the part's alone), replacing the last Done's, and answers what the
 * value names them by: nothing when the board holds none. */
export function holdDrawingPictures(key: string, held: DrawingPicture[]) {
  if (!held.length) {
    pictures.delete(key);
    return;
  }
  pictures.set(key, held);
  return key;
}

export const heldDrawingPictures = (value: DrawingValue) =>
  (value.pictures && pictures.get(value.pictures)) || [];

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

/** A practice quiz's drafts: kept until Check sends their drawings. */
export const quizDraftScope = (quizId: string) => `quiz:${quizId}`;

/** Forgets the drafts of the drawings a check sent: they are on the server. */
export function forgetDrawingDrafts(scope: string, answers: Answers) {
  for (const [part, value] of Object.entries(answers))
    if (isDrawingValue(value))
      deleteLocalDrawingDraft(drawingDraftKey(scope, part)).catch(
        () => undefined
      );
}

/** Stores a drawing part's board with Done and returns its id, or with null
 * (Done on an emptied board) forgets it: an assignment's, whose attempt is on
 * the server from the start. Practice has none, so its drawings stay on the
 * device until Check sends them (Epo 2026-11-06). `withImage` says whether Done
 * makes the marking image: an assignment marked by hand reads none (Q693). */
export const DrawingUploader = createContext<{
  store: (partId: string, value: DrawingValue | null) => Promise<string | null>;
  withImage: boolean;
} | null>(null);

const DATA_URL_PREFIX = /^data:[^;,]+;base64,/;

/** A drawing as a check or a Done sends it: the board, the marking image and,
 * where the drawing is stored, the board's pictures, all in base64. */
export async function drawingUpload(value: DrawingValue, withPictures = true) {
  const held = withPictures ? heldDrawingPictures(value) : [];
  const sent = await Promise.all(
    held.map(async ({ file, id }) => ({
      data: toBase64(new Uint8Array(await file.arrayBuffer())),
      sourceId: id,
    }))
  );
  return {
    board: value.board,
    image: value.image.replace(DATA_URL_PREFIX, ''),
    ...(sent.length ? { pictures: sent } : {}),
  };
}

/** The answers a check sends: each drawing as its board, image and pictures.
 * A shared page's check stores nothing, so it sends no pictures. */
export async function answersForCheck(answers: Answers, withPictures = true) {
  const sent = await Promise.all(
    Object.entries(answers).map(
      async ([part, value]) =>
        [
          part,
          isDrawingValue(value)
            ? await drawingUpload(value, withPictures)
            : value,
        ] as const
    )
  );
  return Object.fromEntries(sent);
}

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
