import { z } from 'zod';

import { createEnumMap } from '../utils/enum.js';

export const NOTE_MIN_WIDTH = 170 + 24 * 2;
export const NOTE_MIN_HEIGHT = 92;

export const DEFAULT_NOTE_WIDTH = 450 + 24 * 2;
export const DEFAULT_NOTE_HEIGHT = NOTE_MIN_HEIGHT;

export const DEFAULT_PAGE_BLOCK_WIDTH = 800;
export const DEFAULT_PAGE_BLOCK_HEIGHT = DEFAULT_NOTE_HEIGHT;

export enum NoteShadow {
  Box = '--affine-note-shadow-box',
  Film = '--affine-note-shadow-film',
  Float = '--affine-note-shadow-float',
  None = '',
  Paper = '--affine-note-shadow-paper',
  Sticker = '--affine-note-shadow-sticker',
}

export const NoteShadowMap = createEnumMap(NoteShadow);

export const NOTE_SHADOWS = [
  NoteShadow.None,
  NoteShadow.Box,
  NoteShadow.Sticker,
  NoteShadow.Paper,
  NoteShadow.Float,
  NoteShadow.Film,
] as const;

export const DEFAULT_NOTE_SHADOW = NoteShadow.Box;

export const NoteShadowsSchema = z.nativeEnum(NoteShadow);

export enum NoteDisplayMode {
  DocAndEdgeless = 'both',
  DocOnly = 'doc',
  EdgelessOnly = 'edgeless',
}

export enum StrokeStyle {
  Dash = 'dash',
  None = 'none',
  Solid = 'solid',
}

export const StrokeStyleSchema = z.nativeEnum(StrokeStyle);

export const NoteDisplayModeSchema = z.nativeEnum(NoteDisplayMode);

export const DEFAULT_NOTE_BORDER_STYLE = StrokeStyle.None;

export const StrokeStyleMap = createEnumMap(StrokeStyle);

export enum NoteCorners {
  Huge = 32,
  Large = 24,
  Medium = 16,
  None = 0,
  Small = 8,
}

export const NoteCornersMap = createEnumMap(NoteCorners);

export const NOTE_CORNERS = [
  NoteCorners.None,
  NoteCorners.Small,
  NoteCorners.Medium,
  NoteCorners.Large,
  NoteCorners.Huge,
] as const;

export const DEFAULT_NOTE_CORNER = NoteCorners.Small;

export const NoteCornersSchema = z.nativeEnum(NoteCorners);

export const DEFAULT_NOTE_BORDER_SIZE = 4;

/** Capy (local change 52): a note is inline, its text on the canvas with no
 * fill, padding or edge, when it has a clear fill, no shadow and no border. A new
 * note starts inline; a card gets a fill, the Box shadow and its corner back. */
export const INLINE_NOTE_FILL = 'transparent';

export function isInlineNote(props: {
  background: unknown;
  edgeless: { style: { shadowType: string; borderStyle: string } };
}) {
  const { shadowType, borderStyle } = props.edgeless.style;
  return (
    props.background === INLINE_NOTE_FILL &&
    !shadowType &&
    borderStyle === StrokeStyle.None
  );
}
