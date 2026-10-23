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
  /** A download failed (mermaid, a theme or a diagram's chunk): the page
   * starts a new worker next time (Epo 2026-10-23). */
  | { notLoaded: true }
  /** Mermaid, the theme and its fonts are in and it starts drawing: the
   * time limit runs from here. */
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

/** A failed dynamic import, as Chromium, Firefox and Safari word it: a
 * diagram type's chunk that did not download, not a fault in the source. */
const FAILED_IMPORT =
  /dynamically imported module|Importing a module script failed/i;

self.onmessage = async ({ data }: MessageEvent<DrawRequest>) => {
  const { code, faces, id, screenWidth, theme, width } = data;
  Object.assign(pageFaces, faces);
  Object.assign(globalThis, { screen: { availWidth: screenWidth } });
  const reply = (body: DrawReply) => self.postMessage(body);
  // Until mermaid, the theme and its fonts are in, a failure is a download's.
  let loading = true;
  try {
    const { drawMermaid, mermaid, themePreset } = await loaded;
    await themePreset(theme);
    loading = false;
    // The site config, which a diagram's directives never reach: the current
    // config still holds the last diagram's until the next render starts
    // (review r2 H1).
    const type = mermaid.detectType(
      code.trim(),
      mermaid.mermaidAPI.getSiteConfig()
    );
    if (!MERMAID_TYPES.has(type)) {
      reply({ id, unsupported: true });
      return;
    }
    reply({ id, started: true });
    const drawn = await drawMermaid(code, theme, host, {
      id: `mmd-${id}`,
      width,
    });
    // A directive can switch a type's renderer: what drew decides.
    reply(
      MERMAID_TYPES.has(drawn.type)
        ? { id, ...drawn }
        : { id, unsupported: true }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply(
      loading || FAILED_IMPORT.test(message)
        ? { id, notLoaded: true }
        : { error: message, id }
    );
  } finally {
    host.replaceChildren();
  }
};
