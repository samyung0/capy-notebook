import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** The edits could not be saved and the editor went back to the last saved
 * version. A failing save that keeps its edits shows the save banner instead. */
export function toastSaveUndone() {
  userToast({
    description: m.editor_save_failed_undone(),
    id: 'save-failed',
    title: m.editor_save_failed(),
    variant: 'error',
  });
}

/** The bind merge of the note's saved copies threw (Q433): the copies stay
 * on this device and merge at the next open. */
export function toastCopyMergeFailed() {
  userToast({
    id: 'copy-merge-failed',
    title: m.editor_copy_merge_failed(),
    variant: 'warning',
  });
}

/** Stored edits from an earlier visit had nothing to draw them over (a tab
 * closed online, then the file moved on) and were dropped. */
export function toastDraftsLost() {
  userToast({
    id: 'drafts-lost',
    title: m.editor_drafts_lost(),
    variant: 'error',
  });
}
