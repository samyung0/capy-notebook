import { iconUrl } from '@/lib/icon-catalog';

/** A workspace's icon and name for table cells, wrapping to two lines. A
 * workspace the viewer cannot list (deleted, or the quiz is gone) has no
 * icon. */
export function WorkspaceCell({
  iconId,
  name,
}: {
  iconId?: string;
  name: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {iconId && (
        <img
          alt=""
          className="size-4 shrink-0 rounded-[4px]"
          height={16}
          src={iconUrl(iconId)}
          width={16}
        />
      )}
      <span className="wrap-break-word line-clamp-2">{name}</span>
    </div>
  );
}
