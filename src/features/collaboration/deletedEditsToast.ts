import type { DeletedItem } from '@/api/client';
import { userToast } from '@/components/ui/userToast';
import type { ExportFormat } from '@/features/notes/export/render';
import { m } from '@/i18n';
import {
  type DeletedDrafts,
  deleteUnheldDrafts,
  draftDocumentHeld,
  type ShownDrafts,
} from '@/lib/editDrafts';
import {
  type DeletedTarget,
  deletedEditsReporter,
  deletedToastId,
  shownDeletedRows,
} from './lostEdits';

/* The page-load toast for a deleted item's unsent edits (Q40 A): Discard and
 * Download; and the open page's Download of what it shows. Apart from
 * lostEdits, which open pages' rooms import, so they never reach the
 * Download's file writers (tsc follows a dynamic import too, and the board's
 * check would take in the note exporters). */

/** The open page's Download (Epo 2026-11-20), on the deleted strip and the
 * header's ⋮: the toast's file (`deletedEditsFile`) from the rows the page
 * shows (`shownDeletedRows`, by id and seq), a note's ⋮ also as Word. It
 * deletes nothing: the strip's Discard still ends them. A file that could not
 * be made says so, the edits kept as they are. */
export async function downloadShownEdits(
  target: DeletedTarget,
  item: DeletedItem,
  format?: ExportFormat
) {
  try {
    const shown = await shownDeletedRows(target);
    const { saveShownEdits } = await import('./deletedEditsFile');
    const drew = await saveShownEdits({ ...target, item }, shown, format);
    for (const { doc } of drew.values()) doc?.destroy();
  } catch (error) {
    console.error(error);
    userToast({ title: m.lost_edits_download_failed(), variant: 'error' });
  }
}

/** The toast's Discard: every row it offered goes, the person's own choice,
 * counted apart from a lost item's silent drop (`item_deleted`). Rows
 * written since (the item restored and opened again) stay, and so does a
 * document an editor holds now. */
export async function discardDeletedEdits(drafts: DeletedDrafts) {
  let bytes = 0;
  for (const key of drafts.keys) {
    const offered = new Set(drafts.offered[key]);
    bytes += (await deleteUnheldDrafts(key, (row) => offered.has(row.id))) ?? 0;
  }
  if (bytes)
    deletedEditsReporter(drafts)('discard_unsaved', 'item_deleted', bytes);
}

/** Download: the file made from the rows the toast offered alone
 * (`deletedEditsFile`), then the rows it drew go, unless an editor holds
 * their document now; the person keeps them, so nothing is counted. Rows it
 * did not draw come back as the next page load's toast, and a file that
 * could not be made keeps them all. */
async function downloadDeletedEdits(drafts: DeletedDrafts) {
  let drew: Map<string, ShownDrafts>;
  try {
    const { saveDeletedEdits } = await import('./deletedEditsFile');
    drew = await saveDeletedEdits(drafts);
  } catch (error) {
    console.error(error);
    userToast({ title: m.lost_edits_download_failed(), variant: 'error' });
    return;
  }
  try {
    await Promise.all(
      [...drew].map(([key, shown]) => {
        const rows = new Set(shown.rows?.map((row) => `${row.id}\n${row.seq}`));
        return deleteUnheldDrafts(key, (row) =>
          rows.has(`${row.id}\n${row.seq}`)
        );
      })
    );
  } finally {
    for (const { doc } of drew.values()) doc?.destroy();
  }
}

/**
 * One deleted item's unsent edits, found by the page-load check (Q40 A, Q44
 * 1): an error toast naming it, with Discard (plain) and Download (filled).
 * Edits that make no file (`canSaveDeletedEdits`, review 2026-11-20) get
 * Discard alone, the toast saying why; a check that fails offers Download,
 * whose failure keeps them. Its × keeps them: the toast shows again at the
 * next page load, until Download or Discard.
 */
export async function offerDeletedEdits(drafts: DeletedDrafts) {
  let drawable = true;
  try {
    const { canSaveDeletedEdits } = await import('./deletedEditsFile');
    drawable = await canSaveDeletedEdits(drafts);
  } catch (error) {
    console.warn('Deleted edits could not be checked:', error);
  }
  // A page here that began showing them meanwhile owns them now (Q39).
  if (drafts.keys.some(draftDocumentHeld)) return;
  userToast({
    ...(drawable && {
      button: {
        label: m.action_download(),
        onClick: () => void downloadDeletedEdits(drafts),
      },
    }),
    description: drawable
      ? m.lost_edits_body()
      : m.lost_edits_body_undrawable(),
    id: deletedToastId(drafts),
    secondary: {
      label: m.action_discard(),
      onClick: () =>
        void discardDeletedEdits(drafts).catch((error) =>
          console.warn('Draft storage failed:', error)
        ),
    },
    title: m.lost_edits_title({ title: drafts.item.name }),
    variant: 'error',
  });
}
