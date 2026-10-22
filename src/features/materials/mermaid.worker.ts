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
  /** Mermaid is loaded and starts drawing: the time limit runs from here. */
  | { started: true }
  /** A type the geometry check does not hold the shim to (Epo 2026-10-23). */
  | { unsupported: true }
);

installDom();
const host = document.body.appendChild(document.createElement('div'));
// After installDom: d3, DOMPurify and Cytoscape bind to the shim on load.
const loaded = Promise.all([import('mermaid'), import('./mermaidDraw')]).then(
  async ([{ default: mermaid }, { drawMermaid }]) => {
    // Registers mermaid's own diagram detectors, which detectType reads.
    await mermaid.registerExternalDiagrams([]);
    return { drawMermaid, mermaid };
  }
);

self.onmessage = async ({ data }: MessageEvent<DrawRequest>) => {
  const { code, faces, id, screenWidth, theme, width } = data;
  Object.assign(pageFaces, faces);
  Object.assign(globalThis, { screen: { availWidth: screenWidth } });
  const reply = (body: DrawReply) => self.postMessage(body);
  try {
    const { drawMermaid, mermaid } = await loaded;
    const type = mermaid.detectType(
      code.trim(),
      mermaid.mermaidAPI.getConfig()
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
    reply({
      error: error instanceof Error ? error.message : String(error),
      id,
    });
  } finally {
    host.replaceChildren();
  }
};
