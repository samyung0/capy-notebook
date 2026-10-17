import {
  type BundledFontFace,
  loadBundledFontBytes,
  registerBundledFontFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  resolveScriptFallbackFace,
} from '@betteroffice/fonts';

/** A face a DOCX layout loaded, under the Office family name it asked for,
 * with the bytes the viewer worker fetched for it. */
export interface OfficeFace {
  bytes: ArrayBuffer;
  face: BundledFontFace;
  family: string;
}

const failures = new Set<(error: Error) => void>();
// Filled only where bytes are kept (the viewer worker).
const used = new Map<string, OfficeFace>();
let keepBytes = false;

/** Reports a bundled face that failed to load; returns the unsubscribe. */
export function onOfficeFontFailure(listener: (error: Error) => void) {
  failures.add(listener);
  return () => {
    failures.delete(listener);
  };
}

/** The viewer worker keeps each loaded face's bytes for the frame that
 * paints its layout, so the frame never fetches them again. */
export function keepOfficeFontBytes() {
  keepBytes = true;
}

// A CSS font shorthand's family list follows its size (`700 16px A, B`).
const FAMILY_LIST = /\d(?:\.\d+)?px(?:\/\S+)?\s+(.+)$/;
const QUOTES = /^["']|["']$/g;

/** The families a display list paints with: every run's `font` and
 * `fallbackFont` shorthand, lowercased. */
export function paintedFamilies(displayList: unknown): Set<string> {
  const families = new Set<string>();
  const add = (font: string) => {
    for (const family of FAMILY_LIST.exec(font)?.[1]?.split(',') ?? [])
      families.add(family.trim().replace(QUOTES, '').toLowerCase());
  };
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === 'font' || key === 'fallbackFont') &&
        typeof item === 'string'
      )
        add(item);
      // A glyph is numbers only, and a run holds one per character.
      else if (key !== 'glyphs') visit(item);
    }
  };
  visit(displayList);
  return families;
}

/**
 * The faces of `loaded` that `displayList` paints with: the browser draws a
 * run only with faces of the families its shorthand names, so the others (a
 * slot's East Asian face for Latin text, say) are left out. A family's weight
 * and style keep the first face loaded for them, as `registerBundledFontFace`
 * does: two FontFaces with the same descriptors would paint with the later.
 */
export function paintedFaces(
  loaded: Iterable<OfficeFace>,
  displayList: unknown
): OfficeFace[] {
  const painted = paintedFamilies(displayList);
  const faces = new Map<string, OfficeFace>();
  for (const used of loaded) {
    const key = `${used.family}|${used.face.weight}|${used.face.style}`;
    if (painted.has(used.family.toLowerCase()) && !faces.has(key))
      faces.set(key, used);
  }
  return [...faces.values()];
}

/** The faces this worker loaded that `displayList` paints with. */
export function usedOfficeFaces(displayList: unknown): OfficeFace[] {
  return paintedFaces(used.values(), displayList);
}

// The faces registered in this window, by family, weight and style.
const registered = new Set<string>();

/**
 * Registers faces from their bytes as FontFaces under their Office family
 * names in this window, each family, weight and style once (the first wins,
 * as `registerBundledFontFace` keys them; a viewer opening again in the same
 * frame adds nothing). The runtime's own interface names only generic
 * families (office-runtime.css), so no document family can repaint it.
 */
export function registerOfficeFaces(faces: readonly OfficeFace[]) {
  return Promise.all(
    faces.map(async ({ bytes, face, family }) => {
      const key = `${family}|${face.weight}|${face.style}`;
      if (registered.has(key)) return;
      registered.add(key);
      const fontFace = new FontFace(family, bytes, {
        style: face.style,
        weight: String(face.weight),
      });
      try {
        await fontFace.load();
      } catch (error) {
        registered.delete(key);
        throw error;
      }
      document.fonts.add(fontFace);
    })
  );
}

function loader(face: BundledFontFace, family: string) {
  return async () => {
    try {
      const bytes = await loadBundledFontBytes(face);
      // What the engine measures is what the page paints (fillText).
      await registerBundledFontFace(face, family);
      if (keepBytes)
        used.set(`${family}|${face.file}`, { bytes, face, family });
      return bytes;
    } catch (value) {
      const error = new Error(`The font ${face.file} failed to load`, {
        cause: value,
      });
      for (const report of failures) report(error);
      throw error;
    }
  };
}

/**
 * The fork's bundled fonts for configureDefaultFonts (record 16): DOCX
 * measures with the metric-compatible faces and the CJK coverage faces
 * (@betteroffice/fonts-cjk, emitted as same-origin assets that load only when
 * a document needs that script), each also registered as a
 * FontFace under the Office family it stands in for (a no-op in a worker).
 * The engine falls back silently when a face fails, so each failure is also
 * reported to onOfficeFontFailure listeners, which show it as an error.
 */
export const officeFonts = {
  createFontProvider: () => ({
    resolve(family: string, bold: boolean, italic: boolean) {
      const face = resolveMetricCompatFace(family, bold, italic);
      return face && loader(face, family);
    },
    resolveLastResort(family: string, bold: boolean, italic: boolean) {
      return loader(resolveLastResortFace(family, bold, italic), family);
    },
    resolveScriptFallback(
      script: Parameters<typeof resolveScriptFallbackFace>[0],
      bold: boolean,
      italic: boolean
    ) {
      const face = resolveScriptFallbackFace(script, bold, italic);
      return face && loader(face, face.family);
    },
  }),
};
