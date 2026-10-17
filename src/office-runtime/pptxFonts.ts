import type { PptxFontFace } from '@betteroffice/pptx/viewer';
import { unzipSync } from 'fflate';
import { officeMark } from '@/lib/officeMarks';
import caladeaBoldUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-Bold.ttf?url';
import caladeaBoldItalicUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-BoldItalic.ttf?url';
import caladeaItalicUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-Italic.ttf?url';
import caladeaRegularUrl from '../../vendor/betteroffice/packages/fonts/assets/Caladea-Regular.ttf?url';
import boldUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Bold.ttf?url';
import boldItalicUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-BoldItalic.ttf?url';
import italicUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Italic.ttf?url';
import regularUrl from '../../vendor/betteroffice/packages/fonts/assets/LiberationSans-Regular.ttf?url';

export interface PptxFaceSource {
  bold: boolean;
  family: 'Arial' | 'Cambria';
  italic: boolean;
  url: string;
}

/**
 * Metric-compatible faces under the names decks ask for: Liberation Sans as
 * Arial, and Caladea as Cambria for the chat decks' editorial titles. The
 * engine falls back to the first face registered, Arial regular, for every
 * family it lacks.
 */
const FACES: readonly PptxFaceSource[] = [
  { bold: false, family: 'Arial', italic: false, url: regularUrl },
  { bold: true, family: 'Arial', italic: false, url: boldUrl },
  { bold: false, family: 'Arial', italic: true, url: italicUrl },
  { bold: true, family: 'Arial', italic: true, url: boldItalicUrl },
  { bold: false, family: 'Cambria', italic: false, url: caladeaRegularUrl },
  { bold: true, family: 'Cambria', italic: false, url: caladeaBoldUrl },
  { bold: false, family: 'Cambria', italic: true, url: caladeaItalicUrl },
  { bold: true, family: 'Cambria', italic: true, url: caladeaBoldItalicUrl },
];
const loads = new Map<PptxFaceSource, Promise<PptxFontFace>>();

/** One face, fetched and registered as a FontFace once per frame. */
export function loadPptxFace(source: PptxFaceSource): Promise<PptxFontFace> {
  let load = loads.get(source);
  if (!load) {
    load = loadFace(source);
    loads.set(source, load);
    const started = load;
    started.catch(() => {
      if (loads.get(source) === started) loads.delete(source);
    });
  }
  return load;
}

/** Every face: an editor can be asked for any style or for Cambria. */
export function loadPptxFonts(): Promise<PptxFontFace[]> {
  return Promise.all(FACES.map(loadPptxFace));
}

// The deck's attributes as pptx-parse reads them (`parse_bool`).
const ITALIC = /\si="(?:1|true|on)"/;
const CAMBRIA = /typeface="\s*cambria\s*"/i;

/**
 * The faces a viewer of this deck can need, from its XML parts (slides,
 * layouts, masters, theme, charts, diagrams): Arial regular and bold always
 * (every family without a face falls back to Arial, and tables and chart
 * titles are bold without saying so), italics only when some part sets
 * italic, and Cambria only when some part names it.
 */
export function pptxDeckFaces(parts: readonly string[]): PptxFaceSource[] {
  const italic = parts.some((part) => ITALIC.test(part));
  const cambria = parts.some((part) => CAMBRIA.test(part));
  return FACES.filter(
    (face) => (face.family === 'Arial' || cambria) && (italic || !face.italic)
  );
}

/** The faces a viewer of `bytes` can need (`pptxDeckFaces`); a deck that is
 * not a readable package fails here, as it would in the engine. */
export async function loadPptxDeckFonts(
  bytes: Uint8Array
): Promise<PptxFontFace[]> {
  const decoder = new TextDecoder();
  const parts = Object.values(
    unzipSync(bytes, {
      filter: (file) =>
        file.name.startsWith('ppt/') && file.name.endsWith('.xml'),
    })
  ).map((part) => decoder.decode(part));
  const faces = pptxDeckFaces(parts);
  officeMark('fonts:faces', { count: faces.length });
  return Promise.all(faces.map(loadPptxFace));
}

async function loadFace({
  bold,
  family,
  italic,
  url,
}: PptxFaceSource): Promise<PptxFontFace> {
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
