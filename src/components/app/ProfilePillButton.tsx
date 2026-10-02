import type { ComponentProps } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The avatar-and-name menu trigger shared by the app bar and public pages.
 * It has no router or API dependency; callers pass the identity they have. */
export function ProfilePillButton({
  avatarUrl,
  className,
  name,
  pending = false,
  ...props
}: ComponentProps<'button'> & {
  avatarUrl?: string;
  name?: string;
  pending?: boolean;
}) {
  return (
    <button
      aria-busy={pending}
      aria-label={pending ? m.a11y_loading() : undefined}
      className={cn(
        BASE_BUTTON_STYLE,
        'flex h-11.5 w-[176px] shrink-0 items-center gap-2.5 rounded-full bg-surface py-1 pr-3 pl-1 hover:bg-surface-hover-bg',
        className
      )}
      type="button"
      {...props}
    >
      {pending ? (
        <>
          <Skeleton className="size-9.5 shrink-0 rounded-full" />
          <Skeleton className="h-4 min-w-0 flex-1" />
        </>
      ) : (
        <>
          <Avatar
            className="size-9.5 text-[15.2px]"
            name={name}
            src={avatarUrl}
          />
          <span
            className="min-w-0 flex-1 truncate text-left font-bold"
            title={name}
          >
            {name ?? '—'}
          </span>
        </>
      )}
      <Icon className="shrink-0 text-fg-muted" name="chevronDown" size={16} />
    </button>
  );
}
