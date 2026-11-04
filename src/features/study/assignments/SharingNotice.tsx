import { useState } from 'react';
import { useMarkSharingNoticeSeen, useSharingNotice } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';

/** Told once, on a class member's first open after joining (board V1): who owns
 * the class (Epo 2026-11-04) and what it and its teaching assistants see of them.
 * These lines must match what the app shares: the report's results and Practice's
 * class count and average. */
export function SharingNotice({ workspace }: { workspace: Workspace }) {
  const due = workspace.kind === 'class' && workspace.role === 'viewer';
  const { data } = useSharingNotice(workspace.id, due);
  const { mutate: markSeen } = useMarkSharingNoticeSeen(workspace.id);
  const [told, setTold] = useState(false);
  if (!due || !data?.due || !data.owner || told) return null;
  const { owner } = data;
  const close = () => {
    setTold(true);
    markSeen();
  };
  return (
    <Dialog onOpenChange={(open) => !open && close()} open>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-135"
        compact
        showCloseButton={false}
      >
        {/* A phone's header sits outside the card's padding, for its ✕. */}
        <DialogTitle className="pb-3 max-sm:pl-2.5" closable={false}>
          {workspace.name}
        </DialogTitle>
        {/* The owner as public pages show one: avatar first, 1px high to meet the
            text. */}
        <p className="t-meta flex min-w-0 items-center gap-2 text-fg-muted">
          <Avatar
            aria-hidden
            className="size-6 shrink-0 -translate-y-px text-[10px]"
            name={owner.name}
            src={owner.avatarUrl || undefined}
          />
          <span className="truncate">{owner.name}</span>
        </p>
        <p className="mt-5 font-medium">{m.sharing_notice_lead()}</p>
        <ul className="mt-3 flex flex-col gap-2.5">
          {[m.sharing_notice_results(), m.sharing_notice_practice()].map(
            (line) => (
              <li className="flex gap-2.5" key={line}>
                <Icon
                  className="mt-0.5 shrink-0 text-fg-muted"
                  name="view"
                  size={18}
                />
                <span>{line}</span>
              </li>
            )
          )}
        </ul>
        <DialogFooter className="pt-4">
          <Button onClick={close}>{m.sharing_notice_ok()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
