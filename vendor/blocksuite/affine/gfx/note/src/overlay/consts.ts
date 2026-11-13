export const NOTE_OVERLAY_CORNER_RADIUS = 6;
/** Capy (local change 48): the board's hairline and placeholder colours. */
export const NOTE_OVERLAY_STOKE_COLOR = '--capy-note-edge';
export const NOTE_OVERLAY_TEXT_COLOR = '--affine-black-30';
export const NOTE_OVERLAY_LIGHT_BACKGROUND_COLOR = 'rgba(252, 252, 253, 1)';
export const NOTE_OVERLAY_DARK_BACKGROUND_COLOR = 'rgb(32, 32, 32)';

/** Capy (local change 48): how an empty note of each kind lays out on the board,
 * measured in model units from the placed note (the board's 8 by 10 padding, the
 * block's margins and type sizes): its height, the placeholder line's top and left,
 * and the line's size, weight and height. The preview copies it, and a click
 * centres the note by its height. */
export type NotePreview = {
  height: number;
  left: number;
  top: number;
  size: number;
  weight: number;
  line: number;
};

const TEXT: NotePreview = {
  height: 59,
  left: 10,
  line: 22.8,
  size: 15,
  top: 18,
  weight: 400,
};
const heading = (
  size: number,
  line: number,
  top: number,
  height: number,
  weight = 600
): NotePreview => ({ height, left: 10, line, size, top, weight });

const NOTE_PREVIEWS: Record<string, NotePreview> = {
  bulleted: { ...TEXT, height: 60, left: 34 },
  h1: heading(28, 36, 26, 80, 700),
  h2: heading(26, 36, 22, 76),
  h3: heading(24, 32, 20, 70),
  h4: heading(22, 30, 20, 68),
  h5: heading(20, 28, 20, 66),
  h6: heading(18, 26, 20, 64),
  numbered: { ...TEXT, height: 60, left: 34 },
  quote: { ...TEXT, height: 82, left: 27, line: 26, top: 28 },
  text: TEXT,
  todo: { ...TEXT, height: 60, left: 34 },
};

/** The layout of a note starting with `childType` (a code block has none, and
 * lays out as text). */
export const notePreviewOf = (childType: string | null) =>
  (childType && NOTE_PREVIEWS[childType]) || TEXT;
