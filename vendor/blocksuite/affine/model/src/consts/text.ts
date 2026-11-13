import { z } from 'zod';

import type { Color } from '../themes/color.js';
import { createEnumMap } from '../utils/enum.js';

export enum TextAlign {
  Center = 'center',
  Left = 'left',
  Right = 'right',
}

export const TextAlignMap = createEnumMap(TextAlign);

export enum TextVerticalAlign {
  Bottom = 'bottom',
  Center = 'center',
  Top = 'top',
}

export type TextStyleProps = {
  color: Color;
  fontFamily: FontFamily;
  fontSize: number;
  fontStyle: FontStyle;
  fontWeight: FontWeight;
  textAlign: TextAlign;
};

export enum FontWeight {
  Bold = '700',
  Light = '300',
  Medium = '500',
  Regular = '400',
  SemiBold = '600',
}

export const FontWeightMap = createEnumMap(FontWeight);

export enum FontStyle {
  Italic = 'italic',
  Normal = 'normal',
}

export enum FontFamily {
  BebasNeue = 'blocksuite:surface:BebasNeue',
  // Capy (local change 44): the app's own fonts, served with it.
  ComicNeue = 'blocksuite:surface:ComicNeue',
  Inter = 'blocksuite:surface:Inter',
  JetBrainsMono = 'blocksuite:surface:JetBrainsMono',
  Kalam = 'blocksuite:surface:Kalam',
  Lora = 'blocksuite:surface:Lora',
  OrelegaOne = 'blocksuite:surface:OrelegaOne',
  Poppins = 'blocksuite:surface:Poppins',
  Satoshi = 'blocksuite:surface:Satoshi',
}

export const FontFamilyMap = createEnumMap(FontFamily);

export const FontFamilyList = Object.entries(FontFamilyMap) as {
  [K in FontFamily]: [K, (typeof FontFamilyMap)[K]];
}[FontFamily][];

/** Capy (local change 44): the fonts the font menu offers, with their names. The
 * board has faces only for these (Inter is drawn in the app's Fustat); AFFiNE's
 * others load from its CDN and never drew here. */
export const BoardFontFamilyList: [FontFamily, string][] = [
  [FontFamily.Inter, 'Fustat'],
  [FontFamily.ComicNeue, 'Comic Neue'],
  [FontFamily.Lora, 'Lora'],
  [FontFamily.JetBrainsMono, 'JetBrains Mono'],
];

export enum TextResizing {
  AUTO_WIDTH_AND_HEIGHT,
  AUTO_HEIGHT,
}

export const FontFamilySchema = z.nativeEnum(FontFamily);
export const FontWeightSchema = z.nativeEnum(FontWeight);
export const FontStyleSchema = z.nativeEnum(FontStyle);
export const TextAlignSchema = z.nativeEnum(TextAlign);
