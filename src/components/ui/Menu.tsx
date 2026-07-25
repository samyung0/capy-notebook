import { cva, type VariantProps } from 'class-variance-authority';
import { type ReactElement, type ReactNode, useState } from 'react';
import { cn } from '@/lib/cn';
import { Card } from './Card';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

const menuVariants = cva('w-auto min-w-36 p-0', {
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
  'flex w-full items-center gap-1.5 rounded-row px-3 py-2 text-left font-semibold transition-colors disabled:opacity-40',
  {
    defaultVariants: {
      danger: false,
    },
    variants: {
      danger: {
        false: 'text-fg hover:bg-surface-hover-bg',
        true: 'text-tint-error-fg hover:bg-tint-error',
      },
    },
  }
);

interface MenuItemBase {
  danger?: boolean;
  disabled?: boolean;
  icon?: IconName;
  label: string;
  onClick?: () => void;
}

export interface MenuItem extends MenuItemBase {
  baseUIRender?: (
    props: MenuItemBase,
    menuDefaultRenderItem: ReactElement,
    key: number | string
  ) => ReactNode;
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

/** Unified action menu — Popover-backed, thick-stroke vertical three-dot used app-wide. */
export function Menu({
  items,
  trigger,
  align = 'end',
  variant = 'default',
  iconContainerClassName,
  alignWidthToTrigger,
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <IconButton
            className={iconContainerClassName}
            icon="moreVertical"
            label="Open menu"
            size="sm"
            strokeWidth={3.5}
            variant="ghost-hover"
          />
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        alignWidthToTrigger={alignWidthToTrigger}
        className={cn(menuVariants({ variant }), className)}
        data-slot="menu"
        data-variant={variant}
      >
        <Card border="solid" className="block p-1" radius="card">
          {items.map((it, i) => {
            const defaultRenderItem = (
              <button
                className={menuItemVariants({ danger: it.danger })}
                disabled={it.disabled}
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  it.onClick?.();
                }}
                role="menuitem"
                type="button"
              >
                {it.icon && <Icon className="size-5" name={it.icon} />}
                <span className="translate-y-px">{it.label}</span>
              </button>
            );

            if (it.baseUIRender) {
              return it.baseUIRender(it, defaultRenderItem, i);
            }

            return defaultRenderItem;
          })}
        </Card>
      </PopoverContent>
    </Popover>
  );
}
