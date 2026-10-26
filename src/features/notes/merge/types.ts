import type { MaterialElement } from '@/features/materials/document';

/**
 * Where a piece came from (merge view, Epo 2026-10-24, Q251):
 * - `refused`: a save the room refused for good, or stored steps no draft
 *   send delivered (Q360);
 * - `changed`: edits made on a version of the note that moved on;
 * - `expired`: unsent edits past the 7-day expiry, never applied raw;
 * - `conflict`: a block of the saved copy edited before the room joined
 *   that someone else changed too (Q229);
 * - `hidden`: typing the room never saw that landed in a block someone
 *   deleted meanwhile, so it never shows (Q237, Q258).
 */
export type PieceSource =
  | 'refused'
  | 'changed'
  | 'expired'
  | 'conflict'
  | 'hidden';

/**
 * One top-level block of the user's version that could not sync into the
 * note, kept on this device until the user resolves it. It holds no Yjs ids:
 * the room's version (`theirs`) is always read live by block id.
 */
export interface MergePiece {
  /** Where an insert goes: the block before it in the user's version. */
  after: string | null;
  /** When it entered the merge view (ms). */
  at: number;
  /** Where the user's edit started (`conflict` only). */
  base?: MaterialElement | null;
  /** The top-level block's id in the user's version. */
  block: string;
  /** The id "Insert as a new block" gave its copy: present in the note, the
   * piece is resolved. */
  insertedAs?: string;
  /** The user's version; null when the user deleted the block. */
  mine: MaterialElement | null;
  /** Only hidden text survived, not the whole block (`mine` is a paragraph
   * of it): it can be inserted or copied, never applied over the block. */
  plain?: true;
  source: PieceSource;
}

/** Derived from the note as it is now, never stored. */
export type PieceStatus =
  | 'conflict'
  | 'theirs-deleted'
  | 'mine-deleted'
  | 'resolved';

/** What the user chose for a piece. */
export type PieceChoice = 'apply' | 'insert' | 'restore' | 'delete';
