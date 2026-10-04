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
