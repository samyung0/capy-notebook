/* Agent markdown to a material document with the editor's own markdown import
   (todo-learning.md, 2.2), so it gives the nodes a paste would.
   scripts/build-markdown.mjs bundles that import to dist/markdown.bundle.mjs;
   it loads on first use, in about half a second. */
export interface ConvertedMarkdown {
  document: { schemaVersion: number; value: unknown[] };
  /** A quiz or flashcard set per fence, in depth-first document order. */
  embedded: (
    | { kind: 'quiz'; questions: unknown[] }
    | { kind: 'flashcards'; cards: { back: string; front: string }[] }
  )[];
}

type Convert = (source: string) => ConvertedMarkdown;

let convert: Promise<Convert> | undefined;

/** Throws an Error naming the fence when one does not parse. */
export function convertAgentMarkdown(
  source: string
): Promise<ConvertedMarkdown> {
  convert ??= import(
    new URL('../dist/markdown.bundle.mjs', import.meta.url).href
  ).then(
    (bundle: { convertAgentMarkdown: Convert }) => bundle.convertAgentMarkdown
  );
  return convert.then((run) => run(source));
}
