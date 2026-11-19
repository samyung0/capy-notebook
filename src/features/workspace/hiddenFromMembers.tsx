import { type ReactNode, useState } from 'react';
import { useSetHidden } from '@/api/hooks';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import type { ContentActionTarget } from './contentActionTarget';

type Target = Pick<ContentActionTarget, 'id' | 'type'>;

/** Hides a workspace item from its members or shares it with them again (Epo
 * 2026-11-03), from the ⋮ menu's "Shared with members" switch or its header's
 * chip; a refusal shows as a toast. Sharing it asks first, as everyone in the
 * workspace then sees it (Epo 2026-11-16): render `dialog` beside what calls
 * `toggle`. `hiddenOf` is the value on its way to the server while a write is
 * out, so the switch moves at once, and the stored one otherwise. */
export function useToggleHidden(workspaceId: string): {
  dialog: ReactNode;
  hiddenOf: (target: Target & { hidden?: boolean }) => boolean;
  toggle: (target: Target, hidden: boolean) => void;
} {
  const { isPending, mutate, variables } = useSetHidden(workspaceId);
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
        body={m.content_share_with_members_body()}
        confirmLabel={m.content_share_with_members()}
        danger={false}
        onClose={() => setShowing(null)}
        onConfirm={() => send(showing, false)}
        open
        title={m.content_share_with_members_title()}
      />
    ),
    hiddenOf: (target) =>
      isPending && variables?.id === target.id
        ? variables.hidden
        : Boolean(target.hidden),
    toggle: (target, hidden) => {
      if (hidden) send(target, true);
      else setShowing(target);
    },
  };
}
