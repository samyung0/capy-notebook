import type { MermaidFont, MermaidPreset } from './mermaidPresets';
import {
  MERMAID_SECURITY,
  withoutImageFunctions,
  withoutImages,
} from './mermaidSafety';
import type { MermaidTheme } from './mermaidThemes';

/* One diagram drawn by mermaid.js in a theme, wherever mermaid runs: the
   app's Web Worker (mermaid.worker.ts, on the DOM shim), or the page in the
   geometry check and the render probe, which compare the two. No React,
   i18n or page DOM here, so the worker bundle stays mermaid's own. */

export interface Drawn {
  /** The theme's panel colour, behind the SVG. */
  background: string;
  svg: string;
  /** The diagram type mermaid drew, by its detected id. */
  type: string;
}

/** The page's or the worker's font set: mermaid measures labels while it
 * draws, so a theme's fonts load first. */
function fontSet(): FontFaceSet {
  return (self as { fonts?: FontFaceSet }).fonts ?? document.fonts;
}

const fonts = new Map<string, Promise<void>>();

function loadFont({ family, url, weight = '400' }: MermaidFont) {
  const key = `${family}|${weight}`;
  let loading = fonts.get(key);
  if (!loading) {
    loading = new FontFace(family, `url(${url})`, { weight })
      .load()
      .then((face) => {
        fontSet().add(face);
      })
      // A drawing measured in the fallback font is wrong for the theme, so
      // the draw fails as a download does and the next one retries (review
      // r3 L3).
      .catch((error: unknown) => {
        fonts.delete(key);
        throw error;
      });
    fonts.set(key, loading);
  }
  return loading;
}

/** The theme's preset with its fonts loaded, since mermaid measures labels
 * while it draws. The worker waits on this before its time limit starts. */
export async function themePreset(theme: MermaidTheme) {
  const { MERMAID_PRESETS } = await import('./mermaidPresets');
  const preset = MERMAID_PRESETS[theme];
  await Promise.all((preset.fonts ?? []).map(loadFont));
  return preset;
}

/** WebKit does not pass a text's dominant-baseline down to its tspans, as
 * Chromium and Firefox do and the worker's shim measures: there a label
 * mermaid centres with `middle` (an ishikawa cause) drew about 4 px above
 * the box drawn around it (review r3 M2's WebKit check). */
const TSPAN_BASELINE =
  'tspan:not([dominant-baseline]) { dominant-baseline: inherit; }';

/**
 * Draws `code` in a theme's `preset` (from themePreset) into `container`
 * (mermaid measures there). Calls must not overlap: mermaid.initialize is
 * global, so each draw sets its own preset; the output CSS is scoped to the
 * SVG's `id`, unique on the page, so diagrams in different themes coexist.
 * `width` is the box a gantt chart spans (it reads its host's width, which
 * the worker's DOM has none of).
 */
export async function drawMermaid(
  code: string,
  preset: MermaidPreset,
  container: Element,
  { id, width }: { id: string; width: number }
): Promise<Drawn> {
  const { default: mermaid } = await import('mermaid');
  // The last diagram's front matter and directives stay in mermaid's config
  // until its next render, and initialize keeps them: without this, the image
  // check below would detect this source under them (review r3 M1).
  mermaid.mermaidAPI.reset();
  mermaid.initialize({
    startOnLoad: false,
    ...preset.config,
    // A Cynefin diagram's wavy boundaries are seeded by the SVG id otherwise.
    cynefin: { ...preset.config.cynefin, seed: 1 },
    // mermaid's default carries a trailing ";", so the page dropped it and
    // measured some labels (ER, class, sequence) in the app's own font; a
    // worker has none. Labels measure in the theme's font they draw in.
    fontFamily: preset.config.themeVariables?.fontFamily,
    gantt: { ...preset.config.gantt, useWidth: width },
    // Shapes mermaid draws with rough.js (class, ER) and Cynefin boundaries
    // come out the same each time, so a source draws one SVG and the
    // geometry check compares.
    handDrawnSeed: 1,
    themeCSS: `${preset.config.themeCSS ?? ''}\n${TSPAN_BASELINE}`,
    ...MERMAID_SECURITY,
  });
  // Nothing that loads a file may reach mermaid (mermaidSafety.ts).
  const source = await withoutImages(
    mermaid,
    withoutImageFunctions(code.trim())
  );
  const { diagramType, svg } = await mermaid.render(id, source, container);
  return {
    background: String(preset.config.themeVariables?.background),
    svg,
    type: diagramType,
  };
}
