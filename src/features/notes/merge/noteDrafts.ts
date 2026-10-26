import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import {
  deleteDrafts,
  draftBytes,
  draftGroups,
  type EditDraft,
  readDrafts,
  recoveryDocument,
  reportRecoveryGroup,
  splitOpenDrafts,
} from '@/lib/editDrafts';
import { editIncidentReporter, reportOnce } from '@/lib/editIncidents';
import { toastDraftsLost } from '../saveFailure';
import { type NoteCopies, type NoteCopy, noteCopies } from './copyDraft';
import { storedPieces } from './pieceRows';
import type { MergePiece, PieceSource } from './types';

/** Stored edits a note's editor turns into pieces once its room synced. */
export type PieceInput =
  /** A refused, other-lineage or expired Yjs group, drawn. */
  | { doc: Y.Doc; rows: EditDraft[]; source: PieceSource }
  /** A saved copy past the 7-day expiry. */
  | { copy: NoteCopy; rows: EditDraft[]; source: PieceSource };

export interface NoteDrafts {
  /** The note's saved copy edited before its room joined (Q229): the
   * editor shows the newest and merges them at the first sync. */
  copies: NoteCopies;
  /** Rows of the current lineage the editor applies: its accepted
   * sessions' (Q326). */
  current: EditDraft[];
  /** The room and mount the rows were read for. */
  for: string;
  /** Rows of never-accepted sessions with stored tokens: the draft send
   * takes them while the editor joins (Q319). */
  pending: EditDraft[];
  /** The merge view's stored pieces, shown at once. */
  pieces: { piece: MergePiece; row: EditDraft }[];
  /** Groups the editor turns into pieces once its room synced (Q251):
   * refused, other-lineage, expired and undelivered (Q360) groups and
   * expired copies. None opens copy-only. */
  sources: PieceInput[];
}

/**
 * Reads a note's stored edits for the room it opens (`for`: room and mount
 * generation, so a remount reads what the old mount wrote): the rows the
 * editor applies or sends (`splitOpenDrafts`, Q326), its copies, its pieces,
 * and every group that becomes pieces. A group or a row nothing can draw or
 * read is dropped with a toast. A group of another lineage or of held rows
 * is reported once (reportRecoveryGroup); a dropped group once per page
 * load. Pieces entering the merge view are no incident (Q261).
 */
export function useNoteDrafts(
  materialId: string,
  key: string | null,
  room: string | undefined,
  generation: number
) {
  const [drafts, setDrafts] = useState<NoteDrafts | null>(null);
  useEffect(() => {
    if (!(key && room)) return;
    let active = true;
    const report = editIncidentReporter('material', materialId);
    void (async () => {
      let rows = await readDrafts(key).catch((error) => {
        console.warn('Draft storage failed:', error);
        return [] as EditDraft[];
      });
      const pieces = storedPieces(rows);
      const copy = noteCopies(rows);
      const unreadable = [...pieces.unreadable, ...copy.unreadable];
      if (unreadable.length) {
        toastDraftsLost();
        await deleteDrafts(unreadable).catch(() => undefined);
      }
      const sources: PieceInput[] = copy.expired.map((expired) => ({
        copy: expired.copy,
        rows: [expired.row],
        source: 'expired',
      }));
      for (;;) {
        const { current, expired, recovery, refused } = await draftGroups(
          rows,
          room
        );
        if (!recovery.length) {
          if (!active) return;
          const { apply, send } = splitOpenDrafts(current);
          setDrafts({
            copies: copy.copies,
            current: apply,
            for: `${room}:${generation}`,
            pending: send,
            pieces: pieces.pieces,
            sources,
          });
          return;
        }
        const doc = recoveryDocument(recovery);
        if (doc) {
          if (!expired) reportRecoveryGroup(recovery, report, refused);
          sources.push({
            doc,
            rows: recovery,
            source: expired ? 'expired' : refused ? 'refused' : 'changed',
          });
        } else {
          toastDraftsLost();
          reportOnce(recovery[0].id, () =>
            report('draft_unrestorable', 'base_missing', draftBytes(recovery))
          );
          await deleteDrafts(recovery).catch(() => undefined);
        }
        rows = rows.filter((row) => !recovery.includes(row));
      }
    })();
    return () => {
      active = false;
    };
  }, [materialId, key, room, generation]);
  return drafts;
}
