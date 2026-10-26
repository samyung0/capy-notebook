import type { EditDraft } from '@/lib/editDrafts';
import type { MergePiece } from './types';

/**
 * Pieces live in the draft store as `piece` rows (the merge view, Q251):
 * JSON kept as bytes, so the drafts worker's size accounting holds; one
 * row per block per document on this device (a deterministic id), its `seq`
 * raised on each rewrite so an exact delete never removes a newer version.
 * Pieces never expire (Q254); they go once resolved, dismissed or the
 * document is lost.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const pieceId = (key: string, block: string) => `piece:${key}:${block}`;

export function pieceRow(
  key: string,
  lineage: string,
  piece: MergePiece,
  seq: number
): EditDraft {
  return {
    data: encoder.encode(JSON.stringify(piece)),
    id: pieceId(key, piece.block),
    key,
    kind: 'piece',
    lineage,
    savedAt: Date.now(),
    seq,
    session: 'piece',
  };
}

/** A document's piece rows, read; rows that cannot be read are left out
 * (`unreadable`). */
export function storedPieces(rows: EditDraft[]) {
  const pieces: { piece: MergePiece; row: EditDraft }[] = [];
  const unreadable: EditDraft[] = [];
  for (const row of rows) {
    if (row.kind !== 'piece') continue;
    try {
      const piece = JSON.parse(decoder.decode(row.data)) as MergePiece;
      if (typeof piece.block === 'string') pieces.push({ piece, row });
      else unreadable.push(row);
    } catch {
      unreadable.push(row);
    }
  }
  return { pieces, unreadable };
}
