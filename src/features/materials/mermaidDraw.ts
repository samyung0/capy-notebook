import type { MermaidFont } from './mermaidPresets';
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

const SVG_OPEN = /<svg[^>]*>/;

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
      // The diagram still draws in the theme's fallback font; retry next time.
      .catch(() => {
        fonts.delete(key);
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

/**
 * Draws `code` in `theme` into `container` (mermaid measures there). Calls
 * must not overlap: mermaid.initialize is global, so each draw sets its own
 * preset; the output CSS is scoped to the SVG's `id`, unique on the page, so
 * diagrams in different themes coexist. `width` is the box a gantt chart
 * spans (it reads its host's width, which the worker's DOM has none of).
 */
export async function drawMermaid(
  code: string,
  theme: MermaidTheme,
  container: Element,
  { id, width }: { id: string; width: number }
): Promise<Drawn> {
  const [{ default: mermaid }, preset, { roughenFilters }] = await Promise.all([
    import('mermaid'),
    themePreset(theme),
    import('./mermaidPresets'),
  ]);
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
    ...MERMAID_SECURITY,
  });
  // Nothing that loads a file may reach mermaid (mermaidSafety.ts).
  const source = await withoutImages(
    mermaid,
    withoutImageFunctions(code.trim())
  );
  const drawn = await mermaid.render(id, source, container);
  let { svg } = drawn;
  if (preset.roughen) {
    svg = svg
      .replaceAll('url(#roughen', `url(#${id}-roughen`)
      .replace(SVG_OPEN, (open) => open + roughenFilters(`${id}-`));
  }
  return {
    background: String(preset.config.themeVariables?.background),
    svg,
    type: drawn.diagramType,
  };
}
