import {
  isMaterialRefElement,
  type MaterialElement,
  type MaterialNode,
  type MaterialValue,
} from '@/features/materials/document';
import { NoteBlocks } from '@/features/notes/liveNoteBlocks';
import { storedPieces } from '@/features/notes/merge/pieceRows';
import { rootOf } from '@/features/notes/merge/pieces';
import { m } from '@/i18n';
import {
  deletedDocument,
  type EditDraft,
  type ShownDrafts,
} from '@/lib/editDrafts';

const decoder = new TextDecoder();

/**
 * A deleted note drawn from its stored edits alone (Q39, Q42), the same for
 * its open page and its Download: the newer of the room document its Yjs rows
 * draw and its newest saved copy (edits made before its room joined, Q229);
 * with neither, its merge view's pieces, each the user's version of a block.
 * What the server holds (images, audio, embedded quizzes and sets,
 * interactive blocks) is a line saying it is not included. `shown`: the
 * rows drawn, which its Discard or Download deletes; the rest stay for the
 * next page load's offer. Null when nothing draws.
 */
export function deletedNote(
  rows: EditDraft[]
): { shown: ShownDrafts; value: MaterialValue } | null {
  const copy = readableCopy(rows);
  const drawn = deletedDocument(rows);
  if (drawn && !(copy && copy.row.savedAt > drawn.newest.savedAt))
    return {
      shown: { doc: drawn.doc, rows: drawn.rows },
      value: offline(new NoteBlocks(rootOf(drawn.doc)).handOver([])),
    };
  drawn?.doc.destroy();
  if (copy) return { shown: { rows: [copy.row] }, value: offline(copy.mine) };
  const { pieces } = storedPieces(rows);
  const blocks = pieces.flatMap(({ piece }) =>
    piece.mine ? [piece.mine] : []
  );
  if (!blocks.length) return null;
  return {
    shown: { rows: pieces.map(({ row }) => row) },
    value: offline(blocks),
  };
}

/** The newest saved copy whose value reads. */
function readableCopy(rows: EditDraft[]) {
  const copies = rows
    .filter((row) => row.kind === 'copy')
    .sort((a, b) => b.savedAt - a.savedAt);
  for (const row of copies) {
    try {
      const { mine } = JSON.parse(decoder.decode(row.data)) as {
        mine: MaterialValue;
      };
      if (Array.isArray(mine)) return { mine, row };
    } catch {
      // Left for the next newest.
    }
  }
  return null;
}

const line = (text: string): MaterialElement => ({
  children: [{ text }],
  type: 'p',
});

/** What of a block would need the server, as a line saying it is left out;
 * a block still uploading (`placeholder`) goes, and a half-typed mention or
 * command reads as its text. */
function offline(nodes: MaterialNode[]): MaterialElement[] {
  const out: MaterialElement[] = [];
  for (const node of nodes) {
    if ('text' in node) continue;
    const kept = withoutFetches(node);
    if (kept) out.push(kept);
  }
  return out;
}

function withoutFetches(node: MaterialElement): MaterialElement | null {
  if (isMaterialRefElement(node))
    return line(
      node.refKind === 'quiz' ? m.lost_edits_quiz() : m.lost_edits_flashcards()
    );
  switch (node.type) {
    case 'img':
    case 'image':
      return line(m.lost_edits_image());
    case 'audio':
      return line(m.lost_edits_audio());
    case 'quiz':
      return line(m.lost_edits_quiz());
    case 'flashcards':
      return line(m.lost_edits_flashcards());
    case 'html_embed':
      return line(m.lost_edits_interactive());
    case 'placeholder':
      return null;
  }
  const children: MaterialNode[] = [];
  for (const child of node.children) {
    if ('text' in child) children.push(child);
    else if (child.type === 'mention_input' || child.type === 'slash_input')
      children.push(...child.children.filter((leaf) => 'text' in leaf));
    else {
      const kept = withoutFetches(child);
      if (kept) children.push(kept);
    }
  }
  return { ...node, children: children.length ? children : [{ text: '' }] };
}
