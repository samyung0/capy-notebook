import { useEffect, useState, useSyncExternalStore } from 'react';
import { dismissToast } from '@/components/ui/userToast';
import type { MaterialValue } from '@/features/materials/document';
import {
  type DeletedDrafts,
  deleteShownDrafts,
  draftKey,
  type EditDraft,
  holdDraftDocument,
  readDrafts,
  type ShownDrafts,
  shownRows,
} from '@/lib/editDrafts';
import { editIncidentReporter } from '@/lib/editIncidents';

/* Unsent edits to an item that was deleted (Epo 2026-11-19 and 2026-11-20,
 * Q39-Q44): the server answers such an item `item_deleted` (410) to whoever
 * could read it, and its trash readers' open pages read it trashed, while an
 * item whose access went answers the non-disclosing 404 and its edits go
 * silently (`dropLostDrafts`). Open, the page shows the edits read-only until
 * Reload; not open, the load sweep's toast offers them. Reload and the
 * toast's Download delete only the rows they showed or drew (`ShownDrafts`):
 * the rest come back as the next page load's toast. The open page's
 * Download, on its strip and its ⋮ (Epo 2026-11-20), deletes none. */

/** A deleted item's stored documents, as the page or the sweep names them. */
export type DeletedTarget = Omit<DeletedDrafts, 'item' | 'offered'>;

/** The documents a page's item keeps drafts under: a quiz's keys beside its
 * content. */
export function deletedTarget(
  actorId: string | undefined,
  file: boolean,
  id: string,
  quiz = false
): DeletedTarget | null {
  if (!actorId) return null;
  const key = draftKey(actorId, file ? 'file' : 'material', id);
  return { file, id, keys: quiz ? [key, `${key}:keys`] : [key] };
}

// What this page shows of each deleted document's stored edits, by key: what
// its Reload deletes; and who is told when that changes.
const shownHere = new Map<string, ShownDrafts>();
const shownListeners = new Set<() => void>();

function shownChanged() {
  for (const listener of shownListeners) listener();
}

/** What an open page shows of a deleted document's stored edits: its Reload
 * deletes those rows and no others. Returns the release. */
export function showDeletedDrafts(key: string, shown: ShownDrafts) {
  shownHere.set(key, shown);
  shownChanged();
  return () => {
    if (shownHere.get(key) !== shown) return;
    shownHere.delete(key);
    shownChanged();
  };
}

function subscribeShown(listener: () => void) {
  shownListeners.add(listener);
  return () => void shownListeners.delete(listener);
}

/** Whether this page shows any of a deleted item's documents' stored edits
 * yet: a room or session draws them after the page reads `kept`, and until
 * then a Download would draw nothing. */
export function useShowsDeleted(target: DeletedTarget | null) {
  const shows = () => !!target?.keys.some((key) => shownHere.has(key));
  return useSyncExternalStore(subscribeShown, shows, shows);
}

/** The rows this page shows of a deleted item's documents, by key, matched
 * by id and seq as Reload matches them (`shownRows`): what its strip's and
 * its ⋮'s Download draw (`downloadShownEdits`). A document it shows nothing of
 * gives none. */
export async function shownDeletedRows(
  target: DeletedTarget
): Promise<Record<string, EditDraft[]>> {
  const rows: Record<string, EditDraft[]> = {};
  for (const key of target.keys) {
    const shown = shownHere.get(key);
    rows[key] = shown ? shownRows(await readDrafts(key), shown) : [];
  }
  return rows;
}

/** Reports a deleted item's discarded edits. */
export const deletedEditsReporter = ({ file, id }: DeletedTarget) =>
  editIncidentReporter(file ? 'source_file' : 'material', id);

/** The open page's Reload: the rows it shows go, counted as the person's
 * discard (`item_deleted`); others stay for the next page load's toast. Then
 * the page loads again. */
export function reloadDeleted(target: DeletedTarget) {
  void (async () => {
    let bytes = 0;
    for (const key of target.keys) {
      const shown = shownHere.get(key);
      if (shown) bytes += await deleteShownDrafts(key, shown);
    }
    if (bytes)
      deletedEditsReporter(target)('discard_unsaved', 'item_deleted', bytes);
  })()
    .catch((error) => console.warn('Draft storage failed:', error))
    .finally(() => window.location.reload());
}

/** The id of a deleted item's page-load toast (`deletedEditsToast`). */
export const deletedToastId = ({ file, id }: DeletedTarget) =>
  `deleted-edits-${file ? 'file' : 'material'}-${id}`;

/** What an open page shows of a deleted item's stored edits. */
export type DeletedEdits =
  | { status: 'checking' | 'none' }
  /** Shown read-only to copy until Reload: a note's drawn here, any other
   * item's by its room or session. */
  | { note?: MaterialValue; status: 'kept' };

/**
 * An item deleted while this page shows it (Q39): whether this device holds
 * unsent edits to it, which the page then keeps on screen read-only (`kept`)
 * rather than saying it is unavailable (`none`); null while it is not
 * deleted. A note's are drawn here (`deletedNote`), as its Download draws
 * them. Meanwhile the page holds its documents, the edits' one owner: no
 * sweep offers or deletes them while it shows them, and a toast offering
 * them already goes. A store that cannot be read shows it unavailable, its
 * rows kept for the next page load's toast.
 */
export function useDeletedEdits(
  target: DeletedTarget | null,
  deleted: boolean,
  note = false
): DeletedEdits | null {
  const [state, setState] = useState<DeletedEdits | null>(null);
  const keys = deleted && target ? target.keys.join(' ') : '';
  const toast = target ? deletedToastId(target) : '';
  useEffect(() => {
    if (!keys) {
      setState(null);
      return;
    }
    const documents = keys.split(' ');
    const releases = documents.map(holdDraftDocument);
    dismissToast(toast);
    let live = true;
    setState({ status: 'checking' });
    void (async () => {
      let rows: EditDraft[][];
      try {
        rows = await Promise.all(documents.map(readDrafts));
      } catch (error) {
        console.warn('Draft storage failed:', error);
        if (live) setState({ status: 'none' });
        return;
      }
      if (!live) return;
      if (!note) {
        setState({ status: rows.some((row) => row.length) ? 'kept' : 'none' });
        return;
      }
      const { deletedNote } = await import('./deletedNote');
      const drawn = deletedNote(rows[0] ?? []);
      if (!live) {
        drawn?.shown.doc?.destroy();
        return;
      }
      if (!drawn) {
        setState({ status: 'none' });
        return;
      }
      releases.push(showDeletedDrafts(documents[0], drawn.shown), () =>
        drawn.shown.doc?.destroy()
      );
      setState({ note: drawn.value, status: 'kept' });
    })();
    return () => {
      live = false;
      for (const release of releases) release();
    };
  }, [keys, note, toast]);
  return state;
}
