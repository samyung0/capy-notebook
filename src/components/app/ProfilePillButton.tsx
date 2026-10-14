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
 * avatar sticking out past its left edge; `row` (sidebar) is a flat nav-row
 * look on the page colour; `avatar` (phone top row) is the avatar alone. */
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
  variant?: 'pill' | 'row' | 'avatar';
}) {
  const row = variant === 'row';
  const avatarClass = {
    avatar: 'size-11 text-[17.6px]',
    pill: '-ml-1 size-13 text-[20.8px]',
    row: 'size-6.5 text-[10.4px]',
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
  if (pending && !row)
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
      aria-busy={pending}
      aria-label={pending ? m.a11y_loading() : undefined}
      className={cn(
        BASE_BUTTON_STYLE,
        row
          ? 'flex h-9 w-full items-center justify-start gap-2.5 overflow-hidden px-2 hover:bg-page-hover'
          : 'flex h-11.5 min-w-36 max-w-50 items-center gap-2.5 rounded-full bg-surface pr-3 hover:bg-surface-hover-bg [[data-style=classroom][data-theme=frappe]_&]:hover:bg-[#283447] [[data-style=classroom][data-theme=mocha]_&]:hover:bg-[#1f2836]',
        className
      )}
      type="button"
      {...props}
    >
      {pending ? (
        <Skeleton className={cn('shrink-0 rounded-full', avatarClass)} />
      ) : (
        // The name beside it labels the button.
        <Avatar
          aria-hidden
          className={avatarClass}
          name={name}
          src={avatarUrl}
        />
      )}
      {pending ? (
        <Skeleton className="h-4 min-w-0 flex-1" />
      ) : (
        <span
          className={cn(
            't-body min-w-0 flex-1 translate-y-px text-left font-bold leading-none',
            // The rail widens under the row, so its name stays on one line.
            row ? 'truncate' : 'line-clamp-2 text-wrap'
          )}
          data-label
          title={name}
        >
          {name ?? '—'}
        </span>
      )}
      <span className="shrink-0" data-label>
        <Icon className="text-fg-muted" name="chevronDown" size={16} />
      </span>
    </button>
  );
}
