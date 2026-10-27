import { useState } from 'react';
import {
  useArchivedConversations,
  useArchivedConversationsAction,
  useDeleteConversation,
  useUpdateConversation,
} from '@/api/hooks';
import type { Conversation } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';

/** The workspace's archived chats (or with a null `workspaceId` the account
 * chat's): each row unarchives or deletes; the footer does either for all;
 * every delete asks first.
 * Phones show the row buttons as icons only, so a row stays one line. */
export function ArchivedChatsDialog({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data: archived } = useArchivedConversations(workspaceId, open, {
    errorBoundary: false,
  });
  const { mutate: update } = useUpdateConversation(workspaceId);
  const { mutate: remove } = useDeleteConversation(workspaceId);
  const { mutate: all, isPending } =
    useArchivedConversationsAction(workspaceId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);

  return (
    <>
      <SimpleDialog
        footer={
          !!archived?.length && (
            <>
              {/* Phones: left, its label in line with the rows; Delete all stays right. */}
              <Button
                className="max-sm:mr-auto"
                disabled={isPending}
                iconLeft="unarchive"
                onClick={() => all('unarchive')}
                size="lg"
                type="button"
                variant="ghost-hover"
              >
                {m.chat_unarchive_all()}
              </Button>
              <Button
                disabled={isPending}
                iconLeft="trash"
                onClick={() => setConfirmDelete(true)}
                size="lg"
                type="button"
                variant="danger"
              >
                {m.chat_delete_all()}
              </Button>
            </>
          )
        }
        onClose={onClose}
        open={open}
        title={m.chat_archived_title()}
        width={620}
      >
        {!archived && <SkeletonList count={3} rowHeight={56} />}
        {archived?.length === 0 && (
          <p className="pb-2 text-fg-muted text-sm">{m.chat_no_archived()}</p>
        )}
        {!!archived?.length && (
          <div className="flex flex-col border-divider border-t">
            {archived.map((c) => (
              <div
                className="flex items-center gap-1 border-divider border-b py-2"
                key={c.id}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-semibold">
                    {c.title || m.chat_untitled()}
                  </span>
                  {c.archivedAt && (
                    <span className="text-fg-muted text-sm">
                      {m.chat_archived_when({
                        when: relativeTime(c.archivedAt),
                      })}
                    </span>
                  )}
                </div>
                {/* Unarchive, then Delete at the row's end; no gap between. */}
                <div className="flex shrink-0">
                  <Button
                    aria-label={m.chat_unarchive()}
                    className="max-sm:px-2"
                    onClick={() => update({ archived: false, id: c.id })}
                    size="sm"
                    type="button"
                    variant="ghost-hover"
                  >
                    <Icon className="-translate-y-px" name="unarchive" />
                    <span className="max-sm:hidden">{m.chat_unarchive()}</span>
                  </Button>
                  <Button
                    aria-label={m.action_delete()}
                    className="max-sm:px-2"
                    onClick={() => setDeleting(c)}
                    size="sm"
                    type="button"
                    variant="danger-light"
                  >
                    <Icon className="-translate-y-px" name="trash" />
                    <span className="max-sm:hidden">{m.action_delete()}</span>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SimpleDialog>
      <ConfirmDialog
        body={m.chat_delete_body()}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove(deleting.id)}
        open={!!deleting}
        title={m.chat_delete_title({
          title: deleting?.title || m.chat_untitled(),
        })}
      />
      <ConfirmDialog
        body={m.chat_delete_all_body()}
        confirmLabel={m.chat_delete_all()}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => all('delete')}
        open={confirmDelete}
        title={m.chat_delete_all_title({
          count: String(archived?.length ?? 0),
        })}
      />
    </>
  );
}
