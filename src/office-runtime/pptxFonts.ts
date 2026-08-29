import type { PptxFontFace } from '@betteroffice/pptx/viewer';
import boldUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Bold.ttf?url';
import boldItalicUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-BoldItalic.ttf?url';
import italicUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Italic.ttf?url';
import regularUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Regular.ttf?url';

let fontsPromise: Promise<PptxFontFace[]> | undefined;

export function loadPptxFonts(): Promise<PptxFontFace[]> {
  fontsPromise ??= Promise.all([
    loadFace(regularUrl, false, false),
    loadFace(boldUrl, true, false),
    loadFace(italicUrl, false, true),
    loadFace(boldItalicUrl, true, true),
  ]);
  return fontsPromise;
}

async function loadFace(
  url: string,
  bold: boolean,
  italic: boolean
): Promise<PptxFontFace> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Font load failed: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (typeof FontFace !== 'undefined' && document.fonts) {
    const face = new FontFace('Arial', buffer.slice(0), {
      style: italic ? 'italic' : 'normal',
      weight: bold ? '700' : '400',
    });
    await face.load();
    document.fonts.add(face);
  }
  return {
    bold,
    bytes: new Uint8Array(buffer),
    family: 'Arial',
    italic,
  };
}
