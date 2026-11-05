import { useSetHidden } from '@/api/hooks';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import type { ContentActionTarget } from './contentActionTarget';

/** Hides a workspace item from its members or shows it again (Epo
 * 2026-11-03), from the item's ⋮ menu or its header's chip; a refusal shows
 * as a toast. */
export function useToggleHidden(workspaceId: string) {
  const { mutate } = useSetHidden(workspaceId);
  return (target: Pick<ContentActionTarget, 'id' | 'type'>, hidden: boolean) =>
    mutate(
      { hidden, id: target.id, type: target.type },
      {
        onError: (error) =>
          userToast({
            title: errorCopy(error, m.source_try_again()),
            variant: 'error',
          }),
      }
    );
}
