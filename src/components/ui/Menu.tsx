import { cva, type VariantProps } from 'class-variance-authority';
import { type ReactElement, type ReactNode, useState } from 'react';
import { cn } from '@/lib/cn';
import { BASE_BUTTON_STYLE } from './Button';
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
            className={cn('p-2', iconContainerClassName)}
            icon="moreVertical"
            label="Open menu"
            size="md"
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
        <Card
          border="solid"
          className="block min-w-[140px] p-1 py-1.5"
          radius="card"
        >
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
                {it.icon && <Icon className="-translate-y-px" name={it.icon} />}
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
