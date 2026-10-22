import type { Drawn } from './mermaidDraw';
import { installDom, pageFaces } from './mermaidShim';
import type { MermaidTheme } from './mermaidThemes';

/* mermaid.js on the DOM shim, one diagram at a time (the page sends the next
   when this one answers, Mermaid.tsx). Nothing here can fetch: linkedom
   loads nothing and the worker has no document. The page sanitizes the SVG
   again before inserting it. */

export interface DrawRequest {
  code: string;
  /** The faces the page draws generic font families in. */
  faces: Record<string, string>;
  id: number;
  theme: MermaidTheme;
  /** The box a gantt chart spans. */
  width: number;
}

export type DrawReply = { id: number } & (
  | Drawn
  | { error: string }
  /** A type the shim does not draw exactly yet: the page draws it on a click. */
  | { page: true }
);

/** The types the geometry check holds the shim to
 * (e2e/editor/mermaid-geometry.spec.ts), by mermaid's detected name. */
export const WORKER_TYPES = new Set([
  'class',
  'classDiagram',
  'er',
  'flowchart',
  'flowchart-v2',
  'gantt',
  'mindmap',
  'pie',
  'sequence',
  'state',
  'stateDiagram',
  'timeline',
]);

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
  const { code, faces, id, theme, width } = data;
  Object.assign(pageFaces, faces);
  const reply = (body: DrawReply) => self.postMessage(body);
  try {
    const { drawMermaid, mermaid } = await loaded;
    if (!WORKER_TYPES.has(mermaid.detectType(code.trim()))) {
      reply({ id, page: true });
      return;
    }
    reply({
      id,
      ...(await drawMermaid(code, theme, host, { id: `mmd-${id}`, width })),
    });
  } catch (error) {
    reply({
      error: error instanceof Error ? error.message : String(error),
      id,
    });
  } finally {
    host.replaceChildren();
  }
};
