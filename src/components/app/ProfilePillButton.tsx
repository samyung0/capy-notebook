import type { ComponentProps } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The avatar-and-name menu trigger shared by the app bar and public pages.
 * It has no router or API dependency; callers pass the identity they have.
 * `pill` (top bar) follows the name between a min and max width with the
 * avatar sticking out past its left edge; `avatar` (phone top row) is the
 * avatar alone. */
export function ProfilePillButton({
  avatarUrl,
  className,
  dot,
  name,
  pending = false,
  variant = 'pill',
  ...props
}: ComponentProps<'button'> & {
  avatarUrl?: string;
  /** Unread notifications, on the `avatar` variant's top right. */
  dot?: boolean;
  name?: string;
  pending?: boolean;
  variant?: 'pill' | 'avatar';
}) {
  const avatarClass = {
    avatar: 'size-11 text-[17.6px]',
    pill: '-ml-1 size-13 text-[20.8px]',
  }[variant];
  if (variant === 'avatar')
    return (
      <button
        aria-busy={pending}
        aria-label={pending ? m.a11y_loading() : name}
        className={cn(BASE_BUTTON_STYLE, 'rounded-full', className)}
        type="button"
        {...props}
      >
        {pending ? (
          <Skeleton className={cn('rounded-full', avatarClass)} />
        ) : (
          <Avatar className={avatarClass} name={name} src={avatarUrl} />
        )}
        {dot && (
          <span className="absolute top-0 right-0 size-2.5 animate-pulse rounded-full bg-solid-error ring-2 ring-surface" />
        )}
      </button>
    );
  // The loading pill is one skeleton of the pill's shape, in the pill's own
  // colour: the default skeleton tone matches the top bar it sits on.
  if (pending)
    return (
      <button
        aria-busy
        aria-label={m.a11y_loading()}
        className={cn(BASE_BUTTON_STYLE, 'h-11.5 w-36 rounded-full', className)}
        type="button"
        {...props}
      >
        <Skeleton className="size-full rounded-full bg-surface" />
      </button>
    );
  return (
    <button
      className={cn(
        BASE_BUTTON_STYLE,
        'flex h-11.5 min-w-36 max-w-50 items-center gap-2.5 rounded-full bg-surface pr-3 hover:bg-surface-hover-bg [[data-style=classroom][data-theme=frappe]_&]:hover:bg-[#283447] [[data-style=classroom][data-theme=mocha]_&]:hover:bg-[#1f2836]',
        className
      )}
      type="button"
      {...props}
    >
      {/* The name beside it labels the button. */}
      <Avatar aria-hidden className={avatarClass} name={name} src={avatarUrl} />
      <span
        className="t-body line-clamp-2 min-w-0 flex-1 translate-y-px text-wrap text-left font-bold leading-none"
        title={name}
      >
        {name ?? '—'}
      </span>
      <Icon className="shrink-0 text-fg-muted" name="chevronDown" size={16} />
    </button>
  );
}
