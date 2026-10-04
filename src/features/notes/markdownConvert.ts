/* The collaboration service's markdown converter: the editor's markdown
   import on the read-only plugin set, so it runs in Node.
   collaboration/scripts/build-markdown.mjs bundles this file. */
import { createSlateEditor, type SlateEditor } from 'platejs';
import YAML from 'yaml';
import type {
  MaterialDocument,
  MaterialNode,
  MaterialRefKind,
} from '@/features/materials/document';
import { StaticMaterialKit } from '@/features/materials/staticPlugins';
import { importMarkdownValue } from './markdownImport';

let editor: SlateEditor | undefined;

export function markdownToDocument(source: string): MaterialDocument {
  editor ??= createSlateEditor({ plugins: StaticMaterialKit });
  return importMarkdownValue(editor, source);
}

/** A quiz or flashcard set to create under the note, in document order. */
export type EmbeddedDraft =
  | { kind: 'quiz'; questions: unknown[] }
  | { kind: 'flashcards'; cards: { back: string; front: string }[] };

function draft(kind: MaterialRefKind, body: string, n: number): EmbeddedDraft {
  const where = `fence ${n} (${kind})`;
  let parsed: unknown;
  try {
    parsed = YAML.parse(body);
  } catch (error) {
    throw new Error(`${where} is not YAML: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const doc = (parsed ?? {}) as { cards?: unknown; questions?: unknown };
  if (kind === 'quiz') {
    if (!Array.isArray(doc.questions) || doc.questions.length === 0)
      throw new Error(`${where} needs a non-empty questions list`);
    return { kind, questions: doc.questions };
  }
  const cards = doc.cards;
  if (
    !Array.isArray(cards) ||
    cards.length === 0 ||
    !cards.every(
      (card) =>
        typeof card?.front === 'string' &&
        card.front.trim() &&
        typeof card?.back === 'string' &&
        card.back.trim()
    )
  )
    throw new Error(`${where} needs cards, each with a front and a back`);
  return {
    cards: cards.map((card) => ({ back: card.back, front: card.front })),
    kind,
  };
}

/** Agent markdown: the document, and a draft for each quiz or flashcards
 * fence in depth-first document order. A fence that does not parse throws,
 * so the agent can fix it, where a paste would keep it pending. */
export function convertAgentMarkdown(source: string): {
  document: MaterialDocument;
  embedded: EmbeddedDraft[];
} {
  const document = markdownToDocument(source);
  const embedded: EmbeddedDraft[] = [];
  const walk = (node: MaterialNode) => {
    if ('text' in node) return;
    if (node.type === 'material_ref' && typeof node.pending === 'string')
      embedded.push(
        draft(
          node.refKind as MaterialRefKind,
          node.pending,
          embedded.length + 1
        )
      );
    node.children.forEach(walk);
  };
  document.value.forEach(walk);
  return { document, embedded };
}
