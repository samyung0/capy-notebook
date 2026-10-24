import { useState } from 'react';
import { useDeleteLostMedia, useLostMedia } from '@/api/hooks';
import type { LostEditorAsset } from '@/api/types';
import { ItemCard, ItemList } from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import type { ListView } from '@/components/app/ListToolbar';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Menu } from '@/components/ui/Menu';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { describeError, unexpectedErrorId } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';
import { formatFileSize } from './fileUtils';

/** Images and audio the viewer added to other people's notes it can no
 * longer open, which it still pays for (M16): listed under their note, never
 * opened, and deleted for good, since nothing restores them. */
export function LostMedia({ view }: { view: ListView }) {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useLostMedia();
  const {
    error,
    isPending,
    mutateAsync: deleteMedia,
    reset,
  } = useDeleteLostMedia();
  const [target, setTarget] = useState<LostEditorAsset | null>(null);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) return null;
  const close = () => {
    if (isPending) return;
    setTarget(null);
    reset();
  };
  return (
    <section className="mt-8 flex flex-col gap-3">
      <h2 className="t-subtitle text-fg">{m.files_lost_media_title()}</h2>
      <p className="t-meta text-fg-muted" role="note">
        {m.files_lost_media_notice()}
      </p>
      <ItemList
        columns={[
          m.list_col_name(),
          m.files_col_note(),
          m.common_size(),
          m.files_sort_added(),
        ]}
        view={view}
      >
        {items.map((item) => {
          const kind = item.purpose === 'audio' ? 'audio' : 'image';
          return (
            <ItemCard
              actions={
                <Menu
                  items={[
                    {
                      danger: true,
                      icon: 'trash',
                      label: m.trash_delete_forever(),
                      onClick: () => setTarget(item),
                    },
                  ]}
                  triggerIcon="moreHorizontal"
                />
              }
              details={formatFileSize(item.sizeBytes)}
              icon={fileIconName({ kind, name: item.name })}
              key={item.assetId}
              meta={relativeTime(item.createdAt)}
              thumbnail={{ fileKind: kind }}
              title={item.name}
              view={view}
              workspace={item.materialTitle || m.files_note_unavailable()}
              workspaceLost
            />
          );
        })}
      </ItemList>
      <ListEnd
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        isFetchNextPageError={isFetchNextPageError}
      />
      <ConfirmDialog
        body={
          target ? m.files_lost_media_delete_body({ name: target.name }) : ''
        }
        closeOnConfirm={false}
        confirmLabel={m.trash_delete_forever()}
        isSubmitting={isPending}
        onClose={close}
        onConfirm={async () => {
          if (!target) return;
          try {
            await deleteMedia(target.assetId);
            setTarget(null);
          } catch {
            // Shown below; the confirmation stays open.
          }
        }}
        open={!!target}
        title={m.trash_delete_confirm_title()}
      >
        <FormAlert
          errorId={error ? unexpectedErrorId(error) : null}
          message={error ? describeError(error).title : null}
        />
      </ConfirmDialog>
    </section>
  );
}
