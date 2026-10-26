import type { EditDraft } from '@/lib/editDrafts';
import type { MergePiece } from './types';

/**
 * Pieces live in the draft store as `piece` rows (the merge view, Q251):
 * JSON kept as bytes, so the drafts worker's size accounting holds; one
 * row per block and content per document on this device (Q409: an id from
 * the block and a hash of `mine`, so a piece never replaces a different one
 * of the same block), its `seq` new on each rewrite and unique across tabs,
 * so an exact delete never removes a newer version (Q410). Pieces never
 * expire (Q254); they go once resolved, dismissed or the document is lost.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** FNV-1a of `mine` as JSON: a piece's content in its key. */
function contentHash(mine: MergePiece['mine']) {
  const json = JSON.stringify(mine);
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < json.length; i++)
    hash = Math.imul(hash ^ json.charCodeAt(i), 0x01_00_01_93);
  return (hash >>> 0).toString(36);
}

/** A piece's key among a document's pieces: its block and content. */
export const pieceKey = (piece: MergePiece) =>
  `${piece.block}:${contentHash(piece.mine)}`;

export const pieceId = (key: string, piece: MergePiece) =>
  `piece:${key}:${pieceKey(piece)}`;

let written = 0;
/** A rewrite's seq: the time with a per-tab counter, so two tabs that read
 * the same row never write the same seq (Q410). */
export const nextPieceSeq = () => Date.now() * 1000 + (written++ % 1000);

export function pieceRow(
  key: string,
  lineage: string,
  piece: MergePiece,
  seq: number
): EditDraft {
  return {
    data: encoder.encode(JSON.stringify(piece)),
    id: pieceId(key, piece),
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
