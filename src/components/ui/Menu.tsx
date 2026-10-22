import { cva } from 'class-variance-authority';
import { Fragment, type ReactNode } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { BASE_BUTTON_STYLE } from './Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';

const menuItemVariants = cva(
  cn(
    BASE_BUTTON_STYLE,
    'flex w-full justify-start gap-2 px-2.5 py-2 font-medium leading-(--body-line-height)'
  ),
  {
    defaultVariants: {
      tone: 'default',
    },
    variants: {
      tone: {
        accent:
          'text-tint-accent-1-fg hover:bg-overlay-hover data-[highlighted]:bg-overlay-hover',
        danger:
          'text-tint-error-fg hover:bg-tint-error data-[highlighted]:bg-tint-error',
        default:
          'text-fg hover:bg-overlay-hover data-[highlighted]:bg-overlay-hover',
        warning:
          'text-tint-warning-fg hover:bg-tint-warning data-[highlighted]:bg-tint-warning',
      },
    },
  }
);

export interface MenuItem {
  /** The item a menu leads with, in the accent colour (Invite member). */
  accent?: boolean;
  /** The current choice of a view switcher: a check at the row's end. */
  checked?: boolean;
  closeOnSelect?: boolean;
  danger?: boolean;
  description?: string;
  disabled?: boolean;
  /** An unread dot on the icon, like IconButton's. */
  dot?: boolean;
  /** Starts a titled section: a small muted label above the item. */
  heading?: string;
  icon?: IconName;
  label: string;
  onClick?: () => void;
  /** A line above the item, between two groups. */
  separated?: boolean;
  /** Something needs the user's attention, short of danger. */
  warning?: boolean;
}

export interface MenuProps {
  align?: 'start' | 'center' | 'end';
  alignWidthToTrigger?: boolean;
  className?: string;
  iconContainerClassName?: string;
  itemClassName?: string;
  items: MenuItem[];
  /** Opens above the trigger, e.g. from a panel's foot. */
  side?: 'top' | 'bottom';
  /** Custom trigger. Defaults to the unified thick vertical 3-dot button. */
  trigger?: ReactNode;
  /** Icon of the default trigger; item cards use the horizontal dots. */
  triggerIcon?: 'moreVertical' | 'moreHorizontal';
}

/** Convenience action list with the shared menu's keyboard and focus behavior. */
export function Menu({
  items,
  trigger,
  triggerIcon = 'moreVertical',
  align = 'end',
  side,
  iconContainerClassName,
  alignWidthToTrigger,
  className,
  itemClassName,
}: MenuProps) {
  const menuTrigger = (
    <DropdownMenuTrigger asChild>
      {trigger ?? (
        <IconButton
          className={cn('p-2', iconContainerClassName)}
          icon={triggerIcon}
          label={m.a11y_open_menu()}
          size="md"
          variant="ghost-hover"
        />
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {menuTrigger}
      <DropdownMenuContent
        align={align}
        className={cn(
          'w-auto min-w-40 p-1 py-1.5',
          alignWidthToTrigger && 'w-(--radix-dropdown-menu-trigger-width)',
          className
        )}
        // A menu pushed off a screen edge stops short of it.
        collisionPadding={8}
        data-slot="menu"
        onClick={(e) => e.stopPropagation()}
        side={side}
      >
        <div data-slot="menu-items">
          {items.map((it, i) => (
            <Fragment key={i}>
              {it.separated && (
                <DropdownMenuSeparator className="mx-1.5 my-1.5 bg-overlay-line" />
              )}
              {it.heading && (
                <DropdownMenuLabel>{it.heading}</DropdownMenuLabel>
              )}
              <DropdownMenuItem
                className={cn(
                  menuItemVariants({
                    tone: it.danger
                      ? 'danger'
                      : it.warning
                        ? 'warning'
                        : it.accent
                          ? 'accent'
                          : 'default',
                  }),
                  itemClassName
                )}
                disabled={it.disabled}
                onSelect={(event) => {
                  if (it.closeOnSelect === false) event.preventDefault();
                  it.onClick?.();
                }}
              >
                {it.icon && (
                  <span className="relative inline-flex shrink-0 -translate-y-px">
                    <Icon name={it.icon} />
                    {it.dot && (
                      <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-solid-error ring-1 ring-overlay" />
                    )}
                  </span>
                )}
                <span className="flex flex-col items-start">
                  <span>{it.label}</span>
                  {it.description && (
                    <span className="font-normal text-fg-muted text-xs">
                      {it.description}
                    </span>
                  )}
                </span>
                {it.checked && (
                  <Icon className="ml-auto -translate-y-px" name="check" />
                )}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
