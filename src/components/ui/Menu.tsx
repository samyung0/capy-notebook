import { cva, type VariantProps } from 'class-variance-authority';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useState,
} from 'react';
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
      morph:
        'min-w-56 overflow-visible rounded-[20px] border-0 bg-transparent shadow-none',
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
  const [morphOpen, setMorphOpen] = useState(false);
  const [morphClosing, setMorphClosing] = useState(false);
  const [morphSize, setMorphSize] = useState({ height: 44, width: 44 });
  const measureMorphContent = useCallback((content: HTMLDivElement | null) => {
    if (!content) return;
    const measure = () =>
      setMorphSize((previous) => {
        const width = content.offsetWidth;
        const height = content.offsetHeight;
        return previous.width === width && previous.height === height
          ? previous
          : { height, width };
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  function changeMorphOpen(open: boolean) {
    setMorphOpen(open);
    setMorphClosing(!open);
  }

  const menuTrigger = (
    <DropdownMenuTrigger
      asChild
      onClick={
        variant === 'morph' ? () => changeMorphOpen(!morphOpen) : undefined
      }
      onPointerDown={
        variant === 'morph'
          ? (event) => {
              // The overlapping menu must open after the pointer is released.
              if (event.button === 0 && !event.ctrlKey) event.preventDefault();
            }
          : undefined
      }
    >
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
  );

  return (
    <DropdownMenu
      modal={variant === 'morph'}
      onOpenChange={variant === 'morph' ? changeMorphOpen : undefined}
      open={variant === 'morph' ? morphOpen : undefined}
    >
      {variant === 'morph' ? (
        <span className="relative inline-flex size-11 shrink-0">
          <span
            className="motion-menu-morph absolute right-0 bottom-0 overflow-hidden bg-surface shadow-sm ring-1 ring-line"
            data-closing={morphClosing || undefined}
            data-open={morphOpen}
            data-slot="menu-morph-surface"
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) setMorphClosing(false);
            }}
            style={
              {
                '--menu-morph-height': `${morphSize.height}px`,
                '--menu-morph-width': `${morphSize.width}px`,
              } as CSSProperties
            }
          >
            {menuTrigger}
          </span>
        </span>
      ) : (
        menuTrigger
      )}
      <DropdownMenuContent
        align={align}
        animationClassName={
          variant === 'morph' ? 'motion-menu-morph-content' : undefined
        }
        className={cn(
          menuVariants({ variant }),
          'p-1 py-1.5',
          alignWidthToTrigger && 'w-(--radix-dropdown-menu-trigger-width)',
          className
        )}
        data-slot="menu"
        data-variant={variant}
        onClick={(e) => e.stopPropagation()}
        ref={variant === 'morph' ? measureMorphContent : undefined}
        side={variant === 'morph' ? 'top' : undefined}
        sideOffset={variant === 'morph' ? -44 : undefined}
      >
        <div data-slot="menu-items">
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
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
