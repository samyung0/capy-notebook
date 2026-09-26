import {
  type BundledFontFace,
  loadBundledFontBytes,
  registerBundledFontFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  resolveScriptFallbackFace,
} from '@betteroffice/fonts';

/** A face a DOCX layout used, under the Office family name it asked for. */
export interface OfficeFace {
  face: BundledFontFace;
  family: string;
}

const failures = new Set<(error: Error) => void>();
const used = new Map<string, OfficeFace>();

/** Reports a bundled face that failed to load; returns the unsubscribe. */
export function onOfficeFontFailure(listener: (error: Error) => void) {
  failures.add(listener);
  return () => {
    failures.delete(listener);
  };
}

/** Every face loaded so far, for a window that paints a worker's layout. */
export function usedOfficeFaces() {
  return [...used.values()];
}

/**
 * Registers faces as FontFaces under their Office family names in this window.
 * The runtime's own interface names only generic families
 * (office-runtime.css), so no document family can repaint it.
 */
export function registerOfficeFaces(faces: readonly OfficeFace[]) {
  return Promise.all(
    faces.map(({ face, family }) => registerBundledFontFace(face, family))
  );
}

// The CJK faces ship in @betteroffice/fonts-cjk (33 MB), which Capy leaves
// out: CJK text keeps the browser's fonts.
const shipped = (face: BundledFontFace | undefined) =>
  face?.script?.startsWith('cjk') ? undefined : face;

function loader(face: BundledFontFace, family: string) {
  return async () => {
    try {
      const bytes = await loadBundledFontBytes(face);
      // What the engine measures is what the page paints (fillText).
      await registerBundledFontFace(face, family);
      used.set(`${family}|${face.file}`, { face, family });
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
 * measures with the metric-compatible faces, each also registered as a
 * FontFace under the Office family it stands in for (a no-op in a worker).
 * The engine falls back silently when a face fails, so each failure is also
 * reported to onOfficeFontFailure listeners, which show it as an error.
 */
export const officeFonts = {
  createFontProvider: () => ({
    resolve(family: string, bold: boolean, italic: boolean) {
      const face = shipped(resolveMetricCompatFace(family, bold, italic));
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
      const face = shipped(resolveScriptFallbackFace(script, bold, italic));
      return face && loader(face, face.family);
    },
  }),
};
