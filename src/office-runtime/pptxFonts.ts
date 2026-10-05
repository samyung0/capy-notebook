import type { PptxFontFace } from '@betteroffice/pptx/viewer';
import caladeaBoldUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-Bold.ttf?url';
import caladeaBoldItalicUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-BoldItalic.ttf?url';
import caladeaItalicUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-Italic.ttf?url';
import caladeaRegularUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-Regular.ttf?url';
import boldUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Bold.ttf?url';
import boldItalicUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-BoldItalic.ttf?url';
import italicUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Italic.ttf?url';
import regularUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Regular.ttf?url';

let fontsPromise: Promise<PptxFontFace[]> | undefined;

/**
 * Metric-compatible faces under the names decks ask for: Liberation Sans as
 * Arial, and Caladea as Cambria for the chat decks' editorial titles.
 */
export function loadPptxFonts(): Promise<PptxFontFace[]> {
  fontsPromise ??= Promise.all([
    loadFace('Arial', regularUrl, false, false),
    loadFace('Arial', boldUrl, true, false),
    loadFace('Arial', italicUrl, false, true),
    loadFace('Arial', boldItalicUrl, true, true),
    loadFace('Cambria', caladeaRegularUrl, false, false),
    loadFace('Cambria', caladeaBoldUrl, true, false),
    loadFace('Cambria', caladeaItalicUrl, false, true),
    loadFace('Cambria', caladeaBoldItalicUrl, true, true),
  ]);
  return fontsPromise;
}

async function loadFace(
  family: string,
  url: string,
  bold: boolean,
  italic: boolean
): Promise<PptxFontFace> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Font load failed: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (typeof FontFace !== 'undefined' && document.fonts) {
    const face = new FontFace(family, buffer.slice(0), {
      style: italic ? 'italic' : 'normal',
      weight: bold ? '700' : '400',
    });
    await face.load();
    document.fonts.add(face);
  }
  return {
    bold,
    bytes: new Uint8Array(buffer),
    family,
    italic,
  };
}
