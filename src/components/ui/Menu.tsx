import { cva } from 'class-variance-authority';
import { Fragment, type ReactNode, useState } from 'react';
import { PendingDot } from '@/components/ui/PendingDot';
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
import { Switch } from './Switch';

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
  /** The current choice of a view switcher: a check at the row's end. On a
   * `switch` row, whether the switch is on. */
  checked?: boolean;
  closeOnSelect?: boolean;
  /** A second click confirms: the first swaps the label for this one and
   * keeps the menu open; closing the menu resets it. Both labels hold one
   * width, so the swap never shifts the menu. */
  confirmLabel?: string;
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
  /** A setting the row turns on and off: a small switch at the row's end
   * shows `checked`, and screen readers hear a checkbox item with its state. */
  switch?: boolean;
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
  // The item showing its confirmLabel, waiting for the second click; held by
  // label, since items can arrive above it while the menu is open.
  const [armed, setArmed] = useState<string | null>(null);
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
    <DropdownMenu onOpenChange={(open) => !open && setArmed(null)}>
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
          {items.map((it) => (
            <Fragment key={it.label}>
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
                // As Radix's own checkbox item: the role and its state.
                {...(it.switch && {
                  'aria-checked': Boolean(it.checked),
                  role: 'menuitemcheckbox',
                })}
                onSelect={(event) => {
                  if (it.confirmLabel && armed !== it.label) {
                    event.preventDefault();
                    setArmed(it.label);
                    return;
                  }
                  if (it.closeOnSelect === false) event.preventDefault();
                  it.onClick?.();
                }}
              >
                {it.icon && (
                  <span className="relative inline-flex shrink-0 -translate-y-px">
                    <Icon name={it.icon} />
                    {it.dot && <PendingDot className="-top-1 -right-1" />}
                  </span>
                )}
                <span className="flex flex-col items-start">
                  {it.confirmLabel ? (
                    <span className="grid">
                      <span
                        className={cn(
                          '[grid-area:1/1]',
                          armed === it.label && 'invisible'
                        )}
                      >
                        {it.label}
                      </span>
                      <span
                        className={cn(
                          '[grid-area:1/1]',
                          armed !== it.label && 'invisible'
                        )}
                      >
                        {it.confirmLabel}
                      </span>
                    </span>
                  ) : (
                    <span>{it.label}</span>
                  )}
                  {it.description && (
                    <span className="font-normal text-fg-muted text-xs">
                      {it.description}
                    </span>
                  )}
                </span>
                {it.switch ? (
                  // The row is the control; the switch only shows its state.
                  <Switch
                    aria-hidden
                    checked={Boolean(it.checked)}
                    className="pointer-events-none ml-auto -translate-y-px"
                    readOnly
                    size="sm"
                    tabIndex={-1}
                  />
                ) : (
                  it.checked && (
                    <Icon className="ml-auto -translate-y-px" name="check" />
                  )
                )}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
