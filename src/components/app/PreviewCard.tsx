import { Slot, Slottable } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';
import {
  type Thumbnail,
  ThumbnailPanel,
} from '@/components/app/ThumbnailPanel';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { cn } from '@/lib/cn';

/** A borderless compact card: the 16:10 preview, then the kind icon and
 * title, with no hint line or pill. The workspace's Recent Files wraps a link
 * in it (`asChild`); the Add file dialog's Create tab uses it as a toggle,
 * where `selected` rings the preview. */
export function PreviewCard({
  icon,
  title,
  thumbnail,
  selected,
  asChild = false,
  className,
  children,
  ...rest
}: ComponentProps<'button'> & {
  icon: FileIconName;
  title: string;
  thumbnail: Thumbnail;
  selected?: boolean;
  asChild?: boolean;
}) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      aria-pressed={selected}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-[15px] p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-action',
        selected
          ? 'bg-tint-accent-1/60 text-tint-accent-1-fg'
          : 'hover:bg-surface-hover-bg',
        className
      )}
      {...(!asChild && { type: 'button' as const })}
      {...rest}
    >
      <Slottable child={children}>
        {(content) => (
          <>
            {content}
            <div
              className={cn(
                'rounded-[13px]',
                selected && 'ring-2 ring-solid-accent-1'
              )}
            >
              <ThumbnailPanel
                dense
                icon={icon}
                {...thumbnail}
                pill={undefined}
              />
            </div>
            <span className="flex min-w-0 items-center gap-1.5 px-1 pb-0.5">
              <FileIcon className="size-3.5 shrink-0" name={icon} />
              <span
                className={cn(
                  'truncate text-[13px] leading-tight',
                  selected && 'font-semibold'
                )}
              >
                {title}
              </span>
            </span>
          </>
        )}
      </Slottable>
    </Component>
  );
}
