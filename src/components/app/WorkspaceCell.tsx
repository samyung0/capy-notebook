import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';

/** A workspace's icon and name for table cells, wrapping to two lines. A
 * workspace the viewer cannot list (deleted, or the quiz is gone) has no
 * icon. `lost`: the viewer no longer has access but still pays for the item
 * (uploader pays): the name shows red behind an error icon. */
export function WorkspaceCell({
  iconId,
  lost = false,
  name,
}: {
  iconId?: string;
  lost?: boolean;
  name: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2.5',
        lost && 'text-tint-error-fg'
      )}
      title={lost ? m.files_lost_access() : undefined}
    >
      {lost ? (
        <Icon className="size-4 shrink-0" name="error" />
      ) : (
        iconId && (
          <img
            alt=""
            className="size-4 shrink-0 rounded-[4px]"
            height={16}
            src={iconUrl(iconId)}
            width={16}
          />
        )
      )}
      <span className="wrap-break-word line-clamp-2">{name}</span>
    </div>
  );
}
