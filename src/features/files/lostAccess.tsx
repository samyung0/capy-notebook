import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** Opening an item the viewer pays for in a workspace it left explains why
 * it stays shut (Epo 2026-10-27); its ⋮ still deletes it. */
export function toastLostAccess() {
  userToast({
    description: m.files_lost_access(),
    title: m.editor_access_lost(),
    variant: 'error',
  });
}
