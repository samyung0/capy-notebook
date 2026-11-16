/* A formula's glyphs as outlines for the SVG export (Epo 2026-11-16, D6): an
 * exported SVG shows inside an <img>, which loads no fonts, so each glyph KaTeX
 * placed is written as its shape, read from KaTeX's own TTF files. Loaded only
 * when a graph holding a formula is exported; the share Worker's build gets an
 * empty module for it (vite.config.ts BROWSER_ONLY). */
import amsRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.ttf?url';
import caligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.ttf?url';
import caligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.ttf?url';
import frakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.ttf?url';
import frakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.ttf?url';
import mainBold from 'katex/dist/fonts/KaTeX_Main-Bold.ttf?url';
import mainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.ttf?url';
import mainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.ttf?url';
import mainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.ttf?url';
import mathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.ttf?url';
import mathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.ttf?url';
import sansSerifBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.ttf?url';
import sansSerifItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.ttf?url';
import sansSerifRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.ttf?url';
import scriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.ttf?url';
import size1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.ttf?url';
import size2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.ttf?url';
import size3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.ttf?url';
import size4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.ttf?url';
import typewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.ttf?url';
import { type Font, parse } from 'opentype.js';

/** A font as the SVG recorder reads a CSS font: its first family and face. */
export type Face = { bold: boolean; family: string; italic: boolean };

/** A glyph run's outline as SVG path data, its pen at (x, y) on the alphabetic
 * baseline at `size` pixels; null when the family is none of KaTeX's. */
export type Outlines = (
  face: Face,
  size: number,
  text: string,
  x: number,
  y: number
) => string | null;

/** KaTeX's files by family, then face. */
const FILES: Record<string, Partial<Record<FaceName, string>>> = {
  KaTeX_AMS: { Regular: amsRegular },
  KaTeX_Caligraphic: { Bold: caligraphicBold, Regular: caligraphicRegular },
  KaTeX_Fraktur: { Bold: frakturBold, Regular: frakturRegular },
  KaTeX_Main: {
    Bold: mainBold,
    BoldItalic: mainBoldItalic,
    Italic: mainItalic,
    Regular: mainRegular,
  },
  KaTeX_Math: { BoldItalic: mathBoldItalic, Italic: mathItalic },
  KaTeX_SansSerif: {
    Bold: sansSerifBold,
    Italic: sansSerifItalic,
    Regular: sansSerifRegular,
  },
  KaTeX_Script: { Regular: scriptRegular },
  KaTeX_Size1: { Regular: size1Regular },
  KaTeX_Size2: { Regular: size2Regular },
  KaTeX_Size3: { Regular: size3Regular },
  KaTeX_Size4: { Regular: size4Regular },
  KaTeX_Typewriter: { Regular: typewriterRegular },
};
type FaceName = 'Bold' | 'BoldItalic' | 'Italic' | 'Regular';

/** The file a face reads from: its own, else the family's one face (KaTeX's
 * Math has only italics, its Size fonts only regular), as a browser matches. */
function fileOf({ bold, family, italic }: Face): string | null {
  const faces = FILES[family];
  if (!faces) return null;
  const name: FaceName =
    bold && italic
      ? 'BoldItalic'
      : bold
        ? 'Bold'
        : italic
          ? 'Italic'
          : 'Regular';
  return faces[name] ?? Object.values(faces)[0] ?? null;
}

/** A face's bytes by its file's address; fetched in the browser. */
export type LoadFont = (url: string) => Promise<ArrayBuffer>;
const fetchFont: LoadFont = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`KaTeX font ${url}: ${response.status}`);
  return response.arrayBuffer();
};

const parsed = new Map<string, Promise<Font>>();

/** Reads the faces `faces` name, once each, and gives their outlines. */
export async function glyphOutlines(
  faces: Iterable<Face>,
  load: LoadFont = fetchFont
): Promise<Outlines> {
  const fonts = new Map<string, Font>();
  await Promise.all(
    [...faces].map(async (face) => {
      const url = fileOf(face);
      if (!url || fonts.has(url)) return;
      let font = parsed.get(url);
      if (!font) {
        font = load(url).then(parse);
        parsed.set(url, font);
        font.catch(() => parsed.delete(url));
      }
      fonts.set(url, await font);
    })
  );
  return (face, size, text, x, y) => {
    const url = fileOf(face);
    if (!url) return null;
    const font = fonts.get(url);
    if (!font) throw new Error(`KaTeX font not loaded: ${face.family}`);
    // A character the face has no glyph for (KaTeX's zero-width spaces) draws
    // nothing, as in the browser, rather than the face's missing-glyph box.
    const pieces: string[] = [];
    font.forEachGlyph(text, x, y, size, undefined, (glyph, gx, gy) => {
      if (glyph.index !== 0)
        pieces.push(glyph.getPath(gx, gy, size).toPathData(1));
    });
    return pieces.join('');
  };
}
