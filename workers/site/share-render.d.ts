/* The share page renderer (src/share/server.tsx), which Vite builds with the
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
}
