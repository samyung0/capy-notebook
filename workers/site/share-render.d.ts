/* The page renderer (src/share/server.tsx), which Vite builds with the
   browser code it renders and wrangler.jsonc aliases. Its source is type
   checked with src; the Worker sees only this surface. */
declare module 'capy-share-render' {
  export const SHARE_TEMPLATE_MARKERS: string[];
  /** The page in the order it is sent: `first`, each of `rest` (a long
   * note's later blocks, rendered when called) and `last`. */
  export function renderSharePagePieces(input: {
    canonical: string;
    page: { kind: 'quizzes' | 'flashcards' | 'notes'; token: string } & (
      | { note: unknown }
      | { quiz: unknown }
      | { set: unknown }
    );
    template: string;
  }): { first: string; last: string; rest: (() => string)[] };

  /** A workspace summary as the API sends it, checked (src/summary/render.ts). */
  export type WorkspaceSummary = { privacy: 'public' | 'link' };
  export const summarySchema: { parse(data: unknown): WorkspaceSummary };
  export function renderSummary(
    template: string,
    summary: WorkspaceSummary,
    id: string,
    sharePath: string,
    appOrigin: string
  ): string;
  /** The error page, inside summary.html when given, standalone otherwise. */
  export function renderFailure(status: number, template?: string): string;
  /** The report-only image-source policy for every rendered page. */
  export const IMAGE_POLICY: string;
}
