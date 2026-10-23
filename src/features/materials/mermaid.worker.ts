import type { Drawn } from './mermaidDraw';
import { installDom, pageFaces } from './mermaidShim';
import type { MermaidTheme } from './mermaidThemes';
import { MERMAID_TYPES } from './mermaidTypes';

/* mermaid.js on the DOM shim, one diagram at a time (the page sends the next
   when this one answers, Mermaid.tsx). Nothing here can fetch: linkedom
   loads nothing and the worker has no document. Mermaid's label sanitizer
   does nothing on linkedom, so the page sanitizes the SVG before inserting
   it (forPage in Mermaid.tsx). */

export interface DrawRequest {
  code: string;
  /** The faces the page draws generic font families in. */
  faces: Record<string, string>;
  id: number;
  /** The page's `screen.availWidth`: C4 lays shapes out within it, and a
   * worker has no screen. */
  screenWidth: number;
  theme: MermaidTheme;
  /** The box a gantt chart spans. */
  width: number;
}

export type DrawReply = { id: number } & (
  | Drawn
  | { error: string }
  /** A download failed (mermaid, a theme or its fonts, a diagram type's
   * code): the page starts a new worker next time (Epo 2026-10-23). */
  | { notLoaded: true }
  /** Everything the draw needs is here and it starts drawing: the time
   * limit runs from here. */
  | { started: true }
  /** A type the geometry check does not hold the shim to (Epo 2026-10-23). */
  | { unsupported: true }
);

installDom();
const host = document.body.appendChild(document.createElement('div'));
// After installDom: d3, DOMPurify and Cytoscape bind to the shim on load.
const loaded = Promise.all([import('mermaid'), import('./mermaidDraw')]).then(
  async ([{ default: mermaid }, { drawMermaid, themePreset }]) => {
    // Registers mermaid's own diagram detectors, which detectType reads.
    await mermaid.registerExternalDiagrams([]);
    return { drawMermaid, mermaid, themePreset };
  }
);

/** Types this worker has drawn, so their code is here. */
const warm = new Set<string>();
/** mermaid's own test for a math label, which it draws with KaTeX, imported
 * while it draws. */
const MATH = /\$\$(.*)\$\$/;

self.onmessage = async ({ data }: MessageEvent<DrawRequest>) => {
  const { code, faces, id, screenWidth, theme, width } = data;
  Object.assign(pageFaces, faces);
  Object.assign(globalThis, { screen: { availWidth: screenWidth } });
  const reply = (body: DrawReply) => self.postMessage(body);
  // A failure while this draw's code downloads (mermaid, the theme and its
  // fonts, the type's code and its layout's, KaTeX) is told from one the
  // source causes by where it happens, never by its message, which can echo
  // the source (review r3 L1). Everything is here before `started`, so the
  // time limit counts drawing only (r3 L5).
  let loading = true;
  try {
    const { drawMermaid, mermaid, themePreset } = await loaded;
    const preset = await themePreset(theme);
    loading = false;
    // The site config, which a diagram's directives never reach: the current
    // config still holds the last diagram's until the next render starts
    // (review r2 H1).
    const type = mermaid.detectType(
      code.trim(),
      mermaid.mermaidAPI.getSiteConfig()
    );
    const small = Object.hasOwn(MERMAID_TYPES, type)
      ? MERMAID_TYPES[type]
      : undefined;
    if (small === undefined) {
      reply({ id, unsupported: true });
      return;
    }
    loading = true;
    if (!warm.has(type)) {
      // Drawing the type's small source, which always draws, downloads its
      // code and its layout's.
      await drawMermaid(small, preset, host, { id: `mmw-${id}`, width });
      host.replaceChildren();
      warm.add(type);
    }
    if (MATH.test(code)) await import('katex');
    loading = false;
    reply({ id, started: true });
    const drawn = await drawMermaid(code, preset, host, {
      id: `mmd-${id}`,
      width,
    });
    // A directive can switch a type's renderer: what drew decides.
    reply(
      Object.hasOwn(MERMAID_TYPES, drawn.type)
        ? { id, ...drawn }
        : { id, unsupported: true }
    );
  } catch (error) {
    reply(
      loading
        ? { id, notLoaded: true }
        : {
            error: error instanceof Error ? error.message : String(error),
            id,
          }
    );
  } finally {
    host.replaceChildren();
  }
};
