import { useRestoreTrashed } from '@/api/hooks';
import type { Trashed } from '@/api/types';
import { FileBanner } from '@/components/banners/FileBanner';
import { getLocale, m } from '@/i18n';

/** A trashed item opened from the Trash (Epo 2026-11-12): it reads as from
 * Files, without editing, until Restore brings it back. */
export function TrashBanner({
  item,
  trash,
  workspaceId,
}: {
  item: { id: string; kind: 'file' | 'material' };
  trash: Trashed;
  workspaceId: string;
}) {
  const { isPending, mutate } = useRestoreTrashed();
  return (
    <FileBanner
      actions={
        // Restoring needs edit access to its workspace.
        trash.canRestore
          ? [
              {
                disabled: isPending,
                label: m.trash_restore(),
                onClick: () =>
                  mutate({
                    episodeId: trash.episodeId,
                    id: item.id,
                    kind: item.kind === 'file' ? 'source_file' : 'material',
                    workspaceId,
                  }),
              },
            ]
          : []
      }
      closeable={false}
      inline
      kind="trash"
      message={m.trash_item_note({
        date: new Intl.DateTimeFormat(getLocale(), {
          dateStyle: 'medium',
        }).format(new Date(trash.purgeAfter)),
      })}
    />
  );
}
