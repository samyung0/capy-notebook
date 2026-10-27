import type { PlateEditor } from 'platejs/react';
import type { MaterialElement } from '@/features/materials/document';
import type { DraftRef } from '@/lib/draftStore';
import { deleteDrafts, type EditDraft, putDrafts } from '@/lib/editDrafts';
import { applyChoice } from './applyPiece';
import { sameBlock } from './blockMerge';
import { nextPieceSeq, pieceKey, piecePrefix, pieceRow } from './pieceRows';
import { pieceStatus } from './pieces';
import type { MergePiece, PieceChoice, PieceStatus } from './types';

/** One piece as the sheet shows it. */
export interface PieceView {
  /** The note's block now (theirs), read live; undefined when gone. */
  current: MaterialElement | undefined;
  /** The piece among the note's: its block and content (`pieceKey`). */
  key: string;
  piece: MergePiece;
  status: PieceStatus;
}

export interface MergeSnapshot {
  /** Whether choices that edit the note can run now (Q255). */
  canApply: boolean;
  /** In document order. */
  pieces: PieceView[];
  /** A piece (its key) whose block changed under the user's choice (first
   * applied wins): nothing was applied, and it shows the fresh block. */
  stale: string | null;
  /** Pieces not resolved yet: the strip shows while there are any. */
  unresolved: number;
}

interface Entry {
  current: MaterialElement | undefined;
  /** Its row's id. */
  id: string;
  /** The block's top-level index last seen, and the inserted copy's. */
  index: number;
  inserted: number;
  key: string;
  piece: MergePiece;
  seq: number;
  /** Unset until first read. */
  status?: PieceStatus;
}

const warn = (error: unknown) => console.warn('Draft storage failed:', error);
/** Two pieces of one block holding the same version. */
const sameAs = (a: MergePiece, b: MergePiece) =>
  a.block === b.block && sameBlock(a.mine, b.mine);
const nextFrame =
  globalThis.requestAnimationFrame?.bind(globalThis) ??
  ((run: () => void) => setTimeout(run, 16) as unknown as number);
const cancelFrame =
  globalThis.cancelAnimationFrame?.bind(globalThis) ??
  ((frame: number) => clearTimeout(frame));

/**
 * A live note mount's pieces (the merge view, Q251): stored
 * on this device, kept current against the editor and chosen on. After a
 * change the store re-reads each piece's block once a frame, O(pieces): the
 * cached index first, and a block object it saw before (Slate nodes are
 * immutable) costs no comparison. A resolved piece stays listed (Applied)
 * until the view closes or the mount ends, so Undo brings it back; its row
 * goes then. Pieces are kept by block and content (Q409): a block may have
 * several, and one equal to a listed piece of its block is not added.
 */
export function createMergeStore({
  editor,
  key,
  lineage,
  onApplyFailed,
  stored,
}: {
  editor: PlateEditor;
  key: string;
  lineage: string;
  /** An apply that threw: an unexpected failure (Q261). */
  onApplyFailed: (piece: MergePiece, error: unknown) => void;
  stored: { piece: MergePiece; row: EditDraft }[];
}) {
  const entries = new Map<string, Entry>();
  let canApply = false;
  let stale: string | null = null;
  let frame: number | null = null;
  let snapshot: MergeSnapshot = {
    canApply,
    pieces: [],
    stale,
    unresolved: 0,
  };
  const listeners = new Set<() => void>();

  /** `id`'s top-level index, trying `hint` first. */
  const locate = (id: string | undefined, hint: number) => {
    if (id === undefined) return -1;
    const { children } = editor;
    if ((children[hint] as MaterialElement | undefined)?.id === id) return hint;
    return children.findIndex((block) => block.id === id);
  };

  /** Re-reads one entry; true when what it shows changed. */
  const read = (entry: Entry) => {
    const { piece } = entry;
    const index = locate(piece.block, entry.index);
    const current =
      index < 0 ? undefined : (editor.children[index] as MaterialElement);
    const inserted = locate(piece.insertedAs, entry.inserted);
    entry.index = index;
    const same =
      current === entry.current &&
      inserted >= 0 === entry.inserted >= 0 &&
      entry.status !== undefined;
    entry.inserted = inserted;
    if (same) return false;
    entry.current = current;
    const status = pieceStatus(piece, (id) =>
      id === piece.block
        ? current
        : inserted >= 0 && id === piece.insertedAs
          ? (editor.children[inserted] as MaterialElement)
          : undefined
    );
    entry.status = status;
    return true;
  };

  const publish = () => {
    const place = (entry: Entry) => {
      if (entry.index >= 0) return entry.index;
      const anchor = locate(entry.piece.after ?? undefined, -1);
      return anchor >= 0 ? anchor + 0.5 : Number.MAX_SAFE_INTEGER;
    };
    const ordered = [...entries.values()]
      .map((entry) => ({ entry, place: place(entry) }))
      .sort((a, b) => a.place - b.place);
    snapshot = {
      canApply,
      pieces: ordered.map(({ entry }) => ({
        current: entry.current,
        key: entry.key,
        piece: entry.piece,
        status: entry.status ?? 'conflict',
      })),
      stale,
      unresolved: ordered.filter(({ entry }) => entry.status !== 'resolved')
        .length,
    };
    for (const listener of listeners) listener();
  };

  const rediff = () => {
    frame = null;
    let changed = false;
    for (const entry of entries.values()) changed = read(entry) || changed;
    if (changed) publish();
  };

  // A row's id is the document's prefix and the piece's key.
  const prefix = piecePrefix(key);
  const keep = (piece: MergePiece, id: string, seq: number) => {
    const entry: Entry = {
      current: undefined,
      id,
      index: -1,
      inserted: -1,
      key: id.startsWith(prefix) ? id.slice(prefix.length) : pieceKey(piece),
      piece,
      seq,
    };
    entries.set(entry.key, entry);
    read(entry);
  };

  /** `piece`'s key: its own, or with `:2`, `:3`... after a different
   * piece of its block that hashed the same (review r2 N1). */
  const free = (piece: MergePiece) => {
    const own = pieceKey(piece);
    let found = own;
    for (let n = 2; ; n++) {
      const entry = entries.get(found);
      if (!entry || sameAs(entry.piece, piece)) return found;
      found = `${own}:${n}`;
    }
  };

  /** The pieces' rows written, each replacing its own key's. */
  const write = (pieces: MergePiece[]) => {
    const rows = pieces.map((piece) => {
      const row = pieceRow(
        key,
        lineage,
        piece,
        nextPieceSeq(),
        `${prefix}${free(piece)}`
      );
      keep(piece, row.id, row.seq);
      return row;
    });
    return rows.length ? putDrafts(rows) : Promise.resolve();
  };

  /** A listed piece of its block holds the same version. */
  const listed = (piece: MergePiece) => {
    for (const entry of entries.values())
      if (sameAs(entry.piece, piece)) return true;
    return false;
  };

  const forget = (keys: string[]) => {
    const refs: DraftRef[] = [];
    for (const each of keys) {
      const entry = entries.get(each);
      if (!entry) continue;
      entries.delete(each);
      refs.push({ id: entry.id, key, seq: entry.seq });
    }
    if (refs.length) void deleteDrafts(refs).catch(warn);
    if (stale && !entries.has(stale)) stale = null;
  };
  const forgetResolved = () =>
    forget(
      [...entries.values()]
        .filter((entry) => entry.status === 'resolved')
        .map((entry) => entry.key)
    );

  for (const { piece, row } of stored) keep(piece, row.id, row.seq);
  publish();

  return {
    /** New pieces (a conversion after the first sync, a merge's
     * conflicts): stored and listed, except one a listed piece of its block
     * holds already (Q409). Resolves once they are stored (the rows they
     * came from go only then, Q397); rejects when the write failed. */
    add(pieces: MergePiece[]) {
      const fresh: MergePiece[] = [];
      for (const piece of pieces)
        if (!(listed(piece) || fresh.some((other) => sameAs(other, piece))))
          fresh.push(piece);
      if (!fresh.length) return Promise.resolve();
      const stored = write(fresh);
      publish();
      return stored;
    },
    /** The user's choice on a piece (its key), against the block they were
     * shown. */
    apply(
      piece: string,
      choice: PieceChoice,
      shown: MaterialElement | undefined
    ) {
      const entry = entries.get(piece);
      if (!(entry && canApply)) return;
      try {
        const done = applyChoice(editor, entry.piece, choice, shown);
        stale = done.result === 'stale' ? piece : null;
        if (done.result === 'applied' && done.insertedAs)
          void write([{ ...entry.piece, insertedAs: done.insertedAs }]).catch(
            warn
          );
      } catch (error) {
        onApplyFailed(entry.piece, error);
      }
      for (const each of entries.values()) read(each);
      publish();
    },
    /** The editor's value changed, locally or from the room. */
    changed() {
      if (!entries.size || frame !== null) return;
      frame = nextFrame(rediff);
    },
    /** The view closed: resolved pieces' rows go. */
    close() {
      forgetResolved();
      publish();
    },
    /** Kept current or discarded: the piece (its key) goes for good
     * (Q253). */
    dismiss(piece: string) {
      forget([piece]);
      publish();
    },
    /** The strip's Discard: every remaining piece (Q252). */
    dismissAll() {
      forget([...entries.keys()]);
      publish();
    },
    /** The mount ends: resolved pieces' rows go as when the view closes. */
    dispose() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      forgetResolved();
      listeners.clear();
    },
    getSnapshot: () => snapshot,
    /** Choices that edit the note need the live, synced, bound note (Q255). */
    setCanApply(next: boolean) {
      if (next === canApply) return;
      canApply = next;
      publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type MergeStore = ReturnType<typeof createMergeStore>;
