import type { DocxViewerSlicedFace } from '@betteroffice/docx/viewer';
import {
  BASE_LATIN_FAMILY,
  type BundledFontFace,
  bundledFontSlices,
  type FontAssetOptions,
  type FontDecoder,
  loadBundledFontBytes,
  registerBundledFontFace,
  resolveBundledFamilyFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  resolveScriptFallbackFace,
  type SliceLocation,
} from '@betteroffice/fonts';

/** A face a DOCX layout loaded, under the Office family name it asked for,
 * with the bytes the viewer worker fetched for it. */
export interface OfficeFace {
  bytes: ArrayBuffer;
  face: BundledFontFace;
  family: string;
}

/** A FontFace's family and descriptors. */
export interface OfficeFamily {
  family: string;
  style?: string;
  weight?: string;
}

/**
 * A sliced (CJK) face the viewer worker measured with: its bytes hold the
 * outline of every glyph the pages draw, under the families the pages paint
 * it with (the Office families it was resolved for, and the private family
 * list markers and watermarks name it by); `files` are its decoded slice
 * files, which Edit's open of the same face takes instead of fetching them.
 */
export interface SlicedOfficeFace {
  bytes: ArrayBuffer;
  families: OfficeFamily[];
  files: Map<string, ArrayBuffer>;
  /** The face's slice index, which names it in every realm. */
  index: string;
}

const failures = new Set<(error: Error) => void>();
// Filled only where bytes are kept (the viewer worker).
const used = new Map<string, OfficeFace>();
// The registry opens a sliced face without calling its loader, so the Office
// families each was resolved for are recorded by slice index instead (viewer
// worker only, as `used`).
const slicedFamilies = new Map<string, Map<string, OfficeFace['face']>>();
// The View's decoded slice files by slice index, for Edit (the frame only).
const sliceFiles = new Map<string, Map<string, ArrayBuffer>>();
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

/** The viewer's sliced faces, each under the families `displayList` paints
 * it with. */
export function slicedOfficeFaces(
  sliced: readonly DocxViewerSlicedFace[],
  displayList: unknown
): SlicedOfficeFace[] {
  const painted = paintedFamilies(displayList);
  return sliced.map(({ bytes, family, files, slices }) => {
    // Opaque to DOCX: the fonts package's location.
    const index = (slices as SliceLocation).ref.index;
    const families: OfficeFamily[] = [{ family }];
    for (const [name, face] of slicedFamilies.get(index) ?? [])
      families.push({
        family: name,
        style: face.style,
        weight: String(face.weight),
      });
    return {
      bytes,
      families: families.filter(({ family }) =>
        painted.has(family.toLowerCase())
      ),
      files,
      index,
    };
  });
}

/** Keeps the View's decoded slice files, which Edit's open takes. */
export function keepSliceFiles(faces: readonly SlicedOfficeFace[]) {
  for (const { files, index } of faces) sliceFiles.set(index, files);
}

/**
 * Registers sliced faces as FontFaces under the families they paint with,
 * for one layout: they hold only the outlines its pages draw. Resolves with
 * what deletes them again.
 */
export async function registerSlicedFaces(faces: readonly SlicedOfficeFace[]) {
  const added: FontFace[] = [];
  const release = () => {
    for (const fontFace of added) document.fonts.delete(fontFace);
  };
  try {
    await Promise.all(
      faces.flatMap(({ bytes, families }) =>
        families.map(async ({ family, style, weight }) => {
          const fontFace = new FontFace(family, bytes, { style, weight });
          await fontFace.load();
          document.fonts.add(fontFace);
          added.push(fontFace);
        })
      )
    );
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/** An open's failure, naming the slice file when a slice failed (a fetch's
 * own network error names none). */
export function openFailure(value: unknown): Error {
  const file = (value as { file?: unknown } | null)?.file;
  if (typeof file === 'string')
    return new Error(
      `The font slice ${file} failed to load: ${value instanceof Error ? value.message : String(value)}`,
      { cause: value }
    );
  return value instanceof Error ? value : new Error(String(value));
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

/** How faces load: their pack's decoder, and no decoded copy kept once a load
 * settles (font bytes live only in the engines' WASM). */
type FaceRuntime = { decoder?: FontDecoder; retain: false };

/**
 * A face's loader. A face shipped in slices also carries where they are, so
 * DOCX opens it from its skeleton and loads only the outline chunks its
 * glyphs need, taking the View's decoded files when Edit opens it.
 */
function loader(
  face: BundledFontFace,
  family: string,
  options: FontAssetOptions | undefined,
  runtime: FaceRuntime
): (() => Promise<ArrayBuffer>) & { slices?: SliceLocation } {
  const load = wholeFaceLoader(face, family, options, runtime);
  const slices = bundledFontSlices(face, options, runtime);
  if (!slices) return load;
  const index = slices.ref.index;
  if (keepBytes) {
    const families = slicedFamilies.get(index) ?? new Map();
    slicedFamilies.set(index, families);
    if (!families.has(family)) families.set(family, face);
  }
  const files = sliceFiles.get(index);
  return Object.assign(load, { slices: files ? { ...slices, files } : slices });
}

function wholeFaceLoader(
  face: BundledFontFace,
  family: string,
  options: FontAssetOptions | undefined,
  runtime: FaceRuntime
) {
  return async () => {
    try {
      // Together, so the face is fetched and decoded once for both. What the
      // engine measures is what the page paints (fillText).
      const [bytes] = await Promise.all([
        loadBundledFontBytes(face, options, runtime),
        registerBundledFontFace(face, family, options, runtime),
      ]);
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

function fontProvider(
  options: FontAssetOptions | undefined,
  decoder: FontDecoder | undefined
) {
  const runtime: FaceRuntime = { decoder, retain: false };
  return {
    resolve(family: string, bold: boolean, italic: boolean) {
      const face = resolveMetricCompatFace(family, bold, italic);
      return face && loader(face, family, options, runtime);
    },
    // DOCX's backstop for characters a document's faces lack (Greek, arrows,
    // dingbats). Without it the engine loads the face itself: with the edit
    // WASM's decoder, kept from the frame, and failing silently.
    resolveBaseLatin(bold: boolean, italic: boolean) {
      const face = resolveBundledFamilyFace(BASE_LATIN_FAMILY, bold, italic);
      return face && loader(face, face.family, options, runtime);
    },
    resolveLastResort(family: string, bold: boolean, italic: boolean) {
      return loader(
        resolveLastResortFace(family, bold, italic),
        family,
        options,
        runtime
      );
    },
    resolveScriptFallback(
      script: Parameters<typeof resolveScriptFallbackFace>[0],
      bold: boolean,
      italic: boolean
    ) {
      const face = resolveScriptFallbackFace(script, bold, italic);
      return face && loader(face, face.family, options, runtime);
    },
  };
}

/**
 * The fork's bundled fonts for configureDefaultFonts (record 16): DOCX
 * measures with the metric-compatible faces, each also registered as a
 * FontFace under the Office family it stands in for (a no-op in a worker),
 * and the CJK coverage faces (@betteroffice/fonts-cjk, same-origin Unicode-
 * range slices of which a document loads only the chunks its pages draw;
 * 2026-10-17). Faces ship packed and decode with the engine's decoder. The
 * engine falls back silently when a whole face fails, so each failure is also
 * reported to onOfficeFontFailure listeners, which show it as an error; a
 * sliced face's failure reaches the open or the editor's onError itself.
 */
export const officeFonts = {
  createFontProvider: (
    options?: FontAssetOptions,
    runtime?: { decoder?: FontDecoder }
  ) => fontProvider(options, runtime?.decoder),
};

/**
 * officeFonts for the DOCX viewer worker: the view WASM links no decoder and
 * the engine's default is the edit WASM's (13 MB), so packed faces decode with
 * the fonts package's own decoder (fontpack.wasm, about 30 KB).
 */
export const officeViewerFonts = {
  createFontProvider: (options?: FontAssetOptions) =>
    fontProvider(options, undefined),
};
