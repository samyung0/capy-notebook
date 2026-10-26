import { yTextToSlateElement } from '@slate-yjs/core';
import * as Y from 'yjs';
import type {
  MaterialElement,
  MaterialValue,
} from '@/features/materials/document';
import { type BlockConflict, mergeBlocks, sameBlock } from './blockMerge';
import type { NoteCopy } from './copyDraft';
import type { MergePiece, PieceSource, PieceStatus } from './types';

/**
 * Turning stored Yjs edits into pieces (the merge view, Q251): a
 * top-level block is the user's to review when the user's document shows
 * something the room's does not. Pure over two documents; every Yjs input
 * (refused, other-lineage and expired drafts) goes through it.
 */

export const rootOf = (doc: Y.Doc) => doc.get('content', Y.XmlText);

/** The top-level block an item lives in (its XmlText in `root`), or null
 * for an item outside the note's blocks. An item in the root holds a block. */
export function topBlock(item: Y.Item, root: Y.XmlText): Y.XmlText | null {
  let current: Y.Item | null = item;
  while (current) {
    const parent: Y.Item['parent'] = current.parent;
    if (parent === root)
      return current.content instanceof Y.ContentType &&
        current.content.type instanceof Y.XmlText
        ? current.content.type
        : null;
    current = parent instanceof Y.AbstractType ? parent._item : null;
  }
  return null;
}

/** Shown: neither the item nor anything holding it is deleted. */
export function visible(item: Y.Item) {
  let current: Y.Item | null = item;
  while (current) {
    if (current.deleted) return false;
    const parent: Y.Item['parent'] = current.parent;
    current = parent instanceof Y.AbstractType ? parent._item : null;
  }
  return true;
}

/** The item at `id` in `doc`, when the document holds it as an item. */
function itemAt(doc: Y.Doc, id: Y.ID): Y.Item | null {
  if (Y.getState(doc.store, id.client) <= id.clock) return null;
  try {
    const struct = Y.getItem(doc.store, id);
    return struct instanceof Y.Item ? struct : null;
  } catch {
    return null;
  }
}

export const blockId = (block: Y.XmlText | null) => {
  const id = block?.getAttribute('id');
  return typeof id === 'string' ? id : null;
};

/**
 * The ids of the top-level blocks in which `user` shows something `room`
 * does not, against `since`, the room's state vector before any of the
 * user's edits:
 * - an item past `since` shown in `user` and not shown in `room` (typing,
 *   inserted elements, attribute changes);
 * - an item below `since` that `user` deletes and `room` still shows (a
 *   deletion that did not land), its block found in `room`.
 */
export function changedBlocks(
  user: Y.Doc,
  room: Y.Doc,
  since: Map<number, number>
) {
  const ids = new Set<string>();
  const userRoot = rootOf(user);
  const roomRoot = rootOf(room);
  user.store.clients.forEach((structs, client) => {
    const known = since.get(client) ?? 0;
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      if (struct.id.clock + struct.length > known) {
        if (!visible(struct)) continue;
        const there = itemAt(room, struct.id);
        if (there && visible(there)) continue;
        const id = blockId(topBlock(struct, userRoot));
        if (id) ids.add(id);
      } else if (struct.deleted) {
        const there = itemAt(room, struct.id);
        if (!(there && visible(there))) continue;
        const id = blockId(topBlock(there, roomRoot));
        if (id) ids.add(id);
      }
    }
  });
  return ids;
}

/** The user's version of each block in `ids` (null when the user's document
 * does not show it) and the block before it there. One pass over the root;
 * only the touched blocks are drawn. */
export function blockVersions(user: Y.Doc, ids: Set<string>) {
  const versions = new Map<
    string,
    { after: string | null; node: MaterialElement | null }
  >();
  let after: string | null = null;
  for (const { insert } of rootOf(user).toDelta() as { insert: unknown }[]) {
    if (!(insert instanceof Y.XmlText)) continue;
    const id = blockId(insert);
    if (!id) continue;
    if (ids.has(id))
      versions.set(id, {
        after,
        node: yTextToSlateElement(insert) as unknown as MaterialElement,
      });
    after = id;
  }
  for (const id of ids)
    if (!versions.has(id)) versions.set(id, { after: null, node: null });
  return versions;
}

/** The pieces a stored Yjs group (drawn as `user`) leaves against the synced
 * room document and the editor's blocks now: changed blocks whose version
 * differs from the current one. */
export function piecesFromDrafts(
  user: Y.Doc,
  room: Y.Doc,
  value: MaterialValue,
  source: PieceSource,
  at = Date.now()
): MergePiece[] {
  const since = Y.decodeStateVector(Y.encodeStateVector(room));
  const current = new Map(value.map((block) => [block.id, block]));
  const pieces: MergePiece[] = [];
  for (const [block, { after, node }] of blockVersions(
    user,
    changedBlocks(user, room, since)
  )) {
    const shown = current.get(block);
    if (node ? shown && sameBlock(node, shown) : !shown) continue;
    pieces.push({ after, at, block, mine: node, source });
  }
  return pieces;
}

/** The pieces of a merge's conflicting blocks (Q229): the room's version
 * stays, the user's waits for a choice. */
export function piecesFromConflicts(
  conflicts: BlockConflict[],
  source: PieceSource,
  at = Date.now()
): MergePiece[] {
  return conflicts.map(({ after, base, id, mine }) => ({
    after,
    at,
    base,
    block: id,
    mine,
    source,
  }));
}

/** Every block a saved copy changed, as pieces and nothing applied: an
 * expired copy is never merged (the 7-day rule). A move alone is no piece. */
export function piecesFromCopy(
  copy: NoteCopy,
  value: MaterialValue,
  source: PieceSource,
  at = Date.now()
): MergePiece[] {
  const before = new Map<string, string | null>();
  let previous: string | null = null;
  for (const block of copy.mine) {
    if (typeof block.id !== 'string') continue;
    before.set(block.id, previous);
    previous = block.id;
  }
  const { conflicts, steps } = mergeBlocks(copy.base, copy.mine, value);
  const pieces: MergePiece[] = [];
  for (const step of steps) {
    if (step.kind === 'move') continue;
    const block = step.kind === 'insert' ? String(step.block.id) : step.id;
    pieces.push({
      after: step.kind === 'insert' ? step.after : (before.get(block) ?? null),
      at,
      block,
      mine: step.kind === 'remove' ? null : step.block,
      source,
    });
  }
  return [...pieces, ...piecesFromConflicts(conflicts, source, at)];
}

/** A piece's status against the note now (`byId`: its top-level blocks). */
export function pieceStatus(
  piece: MergePiece,
  byId: (id: string) => MaterialElement | undefined
): PieceStatus {
  if (piece.insertedAs && byId(piece.insertedAs)) return 'resolved';
  const current = byId(piece.block);
  if (!piece.mine) return current ? 'mine-deleted' : 'resolved';
  if (!current) return 'theirs-deleted';
  return sameBlock(current, piece.mine) ? 'resolved' : 'conflict';
}
