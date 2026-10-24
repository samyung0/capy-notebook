import { yTextToSlateElement } from '@slate-yjs/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { Material, MaterialCollaborationToken } from '@/api/types';
import { SaveBanner } from '@/components/banners/SaveBanner';
import type {
  MaterialDocument,
  MaterialValue,
} from '@/features/materials/document';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import {
  deleteDrafts,
  draftBytes,
  draftGroups,
  type EditDraft,
  readDrafts,
  recoveryDocument,
  reportRecoveryGroup,
  sendBeforeJoin,
} from '@/lib/editDrafts';
import { editIncidentReporter, reportOnce } from '@/lib/editIncidents';
import type { NoteEditorStatus } from './editorMode';
import { afterPaint, type NoteView } from './roomSwap';
import { toastDraftsLost } from './saveFailure';

export interface NoteDrafts {
  /** Rows of the current lineage, merged into the live note. */
  current: EditDraft[];
  /** The room and mount the rows were read for. */
  for: string;
  /** One refused or other-lineage group, shown read-only first. */
  recovery: { doc: Y.Doc; refused: boolean; rows: EditDraft[] } | null;
}

/**
 * Reads a note's stored edits for the room it opens (`for`: room and mount
 * generation, so a remount reads what the old mount wrote), once the ones its
 * room takes went through `/drafts` with their stored tokens (Q288,
 * `sendBeforeJoin`). A recovery group
 * nothing can draw is dropped with a toast and the next one is read. Both
 * are reported (edit_incidents): a group of another lineage once
 * (reportRecoveryGroup), a dropped group once per page load.
 */
export function useNoteDrafts(
  materialId: string,
  key: string | null,
  token: MaterialCollaborationToken | undefined,
  generation: number
) {
  const [drafts, setDrafts] = useState<NoteDrafts | null>(null);
  const room = token?.room;
  // Read when the room is known; a refreshed token does not read again.
  const tokenNow = useRef(token);
  tokenNow.current = token;
  useEffect(() => {
    if (!(key && room && tokenNow.current)) return;
    let active = true;
    const report = editIncidentReporter('material', materialId);
    const sent = sendBeforeJoin(key, tokenNow.current);
    void (async () => {
      await sent;
      let rows = await readDrafts(key).catch((error) => {
        console.warn('Draft storage failed:', error);
        return [] as EditDraft[];
      });
      for (;;) {
        const { current, recovery } = draftGroups(rows, room);
        if (!recovery.length) {
          if (active)
            setDrafts({
              current,
              for: `${room}:${generation}`,
              recovery: null,
            });
          return;
        }
        const doc = recoveryDocument(recovery);
        if (doc) {
          reportRecoveryGroup(recovery, report);
          if (active)
            setDrafts({
              current,
              for: `${room}:${generation}`,
              recovery: { doc, refused: !!recovery[0].refused, rows: recovery },
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
 * Edits that cannot join the live note (a refused save, or a room that moved
 * on while they waited), read-only and selectable for copying. Reload deletes
 * them and opens the live note.
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
    () => ({
      schemaVersion: 1,
      value: yTextToSlateElement(recovery.doc.get('content', Y.XmlText))
        .children as MaterialValue,
    }),
    [recovery.doc]
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
        state={recovery.refused ? 'refused' : 'changed'}
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
