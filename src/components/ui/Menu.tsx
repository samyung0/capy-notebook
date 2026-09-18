import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { BASE_BUTTON_STYLE } from './Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';

const menuVariants = cva('w-auto min-w-40 p-0', {
  defaultVariants: {
    variant: 'default',
  },
  variants: {
    variant: {
      default: '',
    },
  },
});

const menuItemVariants = cva(
  cn(
    BASE_BUTTON_STYLE,
    'flex w-full justify-start gap-2 px-2.5 py-2 font-medium leading-(--body-line-height)'
  ),
  {
    defaultVariants: {
      danger: false,
    },
    variants: {
      danger: {
        false:
          'text-fg hover:bg-surface-hover-bg data-[highlighted]:bg-surface-hover-bg',
        true: 'text-tint-error-fg hover:bg-tint-error data-[highlighted]:bg-tint-error',
      },
    },
  }
);

export interface MenuItem {
  closeOnSelect?: boolean;
  danger?: boolean;
  description?: string;
  disabled?: boolean;
  icon?: IconName;
  label: string;
  onClick?: () => void;
}

export interface MenuProps extends VariantProps<typeof menuVariants> {
  align?: 'start' | 'center' | 'end';
  alignWidthToTrigger?: boolean;
  className?: string;
  iconContainerClassName?: string;
  items: MenuItem[];
  /** Custom trigger. Defaults to the unified thick vertical 3-dot button. */
  trigger?: ReactNode;
}

/** Convenience action list with the shared menu's keyboard and focus behavior. */
export function Menu({
  items,
  trigger,
  align = 'end',
  variant = 'default',
  iconContainerClassName,
  alignWidthToTrigger,
  className,
}: MenuProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <IconButton
            className={cn('p-2', iconContainerClassName)}
            icon="moreVertical"
            label={m.a11y_open_menu()}
            size="md"
            variant="ghost-hover"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn(
          menuVariants({ variant }),
          'p-1 py-1.5',
          alignWidthToTrigger && 'w-(--radix-dropdown-menu-trigger-width)',
          className
        )}
        data-slot="menu"
        data-variant={variant}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <DropdownMenuItem
            className={menuItemVariants({ danger: it.danger })}
            disabled={it.disabled}
            key={i}
            onSelect={(event) => {
              if (it.closeOnSelect === false) event.preventDefault();
              it.onClick?.();
            }}
          >
            {it.icon && <Icon className="-translate-y-px" name={it.icon} />}
            <span className="flex flex-col items-start">
              <span>{it.label}</span>
              {it.description && (
                <span className="font-normal text-fg-muted text-xs">
                  {it.description}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
