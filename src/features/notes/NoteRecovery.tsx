import { yTextToSlateElement } from '@slate-yjs/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { Material } from '@/api/types';
import { recoveryBanner, SaveBanner } from '@/components/banners/SaveBanner';
import type {
  MaterialDocument,
  MaterialValue,
} from '@/features/materials/document';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import {
  deleteDrafts,
  draftBytes,
  draftGroups,
  dropExpiredGroup,
  type EditDraft,
  readDrafts,
  recoveryDocument,
  reportRecoveryGroup,
  splitOpenDrafts,
} from '@/lib/editDrafts';
import { editIncidentReporter, reportOnce } from '@/lib/editIncidents';
import type { NoteEditorStatus } from './editorMode';
import {
  heldCopies,
  NO_COPIES,
  type NoteCopies,
  noteCopies,
} from './merge/copyDraft';
import { afterPaint, type NoteView } from './roomSwap';
import { toastDraftsLost } from './saveFailure';

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
  /** One refused, other-lineage or expired group, or the blocks a copy's
   * merge could not take (`conflict`, Q229), shown read-only first (an
   * expired one once: its rows are deleted as it opens). */
  recovery: {
    conflict?: boolean;
    expired: boolean;
    refused: boolean;
    rows: EditDraft[];
    value: MaterialValue;
  } | null;
}

/**
 * Reads a note's stored edits for the room it opens (`for`: room and mount
 * generation, so a remount reads what the old mount wrote), split by who
 * sends them (`splitOpenDrafts`, Q326), and its copy rows (Q229,
 * `noteCopies`). A recovery group, or a copy row, nothing can draw is
 * dropped with a toast and the next one is read. Both
 * are reported (edit_incidents): a group of another lineage or held rows
 * shown copy-only once (reportRecoveryGroup), a dropped group once per page
 * load.
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
      for (;;) {
        const { current, expired, recovery, refused } = await draftGroups(
          rows,
          room
        );
        if (!recovery.length) {
          const copy = noteCopies(rows, await heldCopies().catch(() => null));
          if (copy.unreadable.length) {
            // Lost work (review r1 L4): reported once, as a group nothing
            // could draw.
            const lost = copy.unreadable;
            toastDraftsLost();
            reportOnce(lost[0].id, () =>
              report('draft_unrestorable', 'unreadable', draftBytes(lost))
            );
            await deleteDrafts(lost).catch(() => undefined);
          }
          // The blocks a copy's merge left, then an expired copy (shown
          // once), copy-only before the live note.
          let shown: Omit<
            NonNullable<NoteDrafts['recovery']>,
            'refused'
          > | null = null;
          if (copy.conflicts)
            shown = { ...copy.conflicts, conflict: true, expired: false };
          else if (copy.expired) {
            shown = {
              expired: true,
              rows: [copy.expired.row],
              value: copy.expired.value,
            };
            dropExpiredGroup(shown.rows, report);
          }
          if (!active) return;
          const { apply, send } = splitOpenDrafts(current);
          setDrafts({
            copies: shown ? NO_COPIES : copy.copies,
            current: shown ? current : apply,
            for: `${room}:${generation}`,
            pending: shown ? [] : send,
            recovery: shown ? { ...shown, refused: false } : null,
          });
          return;
        }
        const doc = recoveryDocument(recovery);
        if (doc) {
          if (expired) dropExpiredGroup(recovery, report);
          else reportRecoveryGroup(recovery, report, refused);
          const value = yTextToSlateElement(doc.get('content', Y.XmlText))
            .children as MaterialValue;
          doc.destroy();
          if (active)
            setDrafts({
              copies: NO_COPIES,
              current,
              for: `${room}:${generation}`,
              pending: [],
              recovery: { expired, refused, rows: recovery, value },
            });
          return;
        }
        toastDraftsLost();
        reportOnce(recovery[0].id, () =>
          report('draft_unrestorable', 'base_missing', draftBytes(recovery))
        );
        await deleteDrafts(recovery).catch(() => undefined);
        rows = rows.filter((row) => !recovery.includes(row));
      }
    })();
    return () => {
      active = false;
    };
  }, [materialId, key, room, generation]);
  return drafts;
}

/**
 * Edits that cannot join the live note (a refused save, a room that moved on
 * while they waited, or blocks a copy's merge could not take), read-only and
 * selectable for copying. Reload deletes them and opens the live note.
 */
export function NoteRecovery({
  material,
  onEditorStatusChange,
  onPainted,
  onReload,
  recovery,
}: {
  material: Material;
  onEditorStatusChange?: (status: NoteEditorStatus | null) => void;
  /** Its content first painted, for a room swap (roomSwap.ts). */
  onPainted?: (view: NoteView) => void;
  onReload: () => void;
  recovery: NonNullable<NoteDrafts['recovery']>;
}) {
  const [reloading, setReloading] = useState(false);
  const scrollArea = useRef<HTMLDivElement>(null);
  const painted = useRef(onPainted);
  painted.current = onPainted;
  useEffect(
    () =>
      afterPaint(() => {
        if (scrollArea.current)
          painted.current?.({ editor: null, scrollArea: scrollArea.current });
      }),
    []
  );
  const content = useMemo<MaterialDocument>(
    () => ({ schemaVersion: 1, value: recovery.value }),
    [recovery.value]
  );
  useEffect(() => {
    onEditorStatusChange?.({ saveState: 'error' });
    return () => onEditorStatusChange?.(null);
  }, [onEditorStatusChange]);
  return (
    <>
      <SaveBanner
        onReload={() => {
          setReloading(true);
          void deleteDrafts(recovery.rows)
            .catch(() => undefined)
            .then(onReload);
        }}
        reloading={reloading}
        state={recoveryBanner(recovery)}
      />
      <div
        className="min-h-0 flex-1 overflow-auto"
        data-note-scroll=""
        data-testid="note-recovery"
        ref={scrollArea}
      >
        <MaterialPreview
          content={content}
          isStandalone={!material.workspaceId}
          kind={material.kind}
          title={material.title}
        />
      </div>
    </>
  );
}
