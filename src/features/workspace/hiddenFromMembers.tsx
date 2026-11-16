import { type ReactNode, useState } from 'react';
import { useSetHidden } from '@/api/hooks';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import type { ContentActionTarget } from './contentActionTarget';

type Target = Pick<ContentActionTarget, 'id' | 'type'>;

/** Hides a workspace item from its members or shows it again (Epo
 * 2026-11-03), from the item's ⋮ menu or its header's chip; a refusal shows
 * as a toast. Showing it asks first, as everyone in the workspace then sees
 * it (Epo 2026-11-16): render `dialog` beside what calls `toggle`. */
export function useToggleHidden(workspaceId: string): {
  dialog: ReactNode;
  toggle: (target: Target, hidden: boolean) => void;
} {
  const { mutate } = useSetHidden(workspaceId);
  const [showing, setShowing] = useState<Target | null>(null);
  const send = (target: Target, hidden: boolean) =>
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
  return {
    dialog: showing && (
      <ConfirmDialog
        body={m.content_unhide_body()}
        confirmLabel={m.content_unhide_file()}
        danger={false}
        onClose={() => setShowing(null)}
        onConfirm={() => send(showing, false)}
        open
        title={m.content_unhide_title()}
      />
    ),
    toggle: (target, hidden) => {
      if (hidden) send(target, true);
      else setShowing(target);
    },
  };
}
