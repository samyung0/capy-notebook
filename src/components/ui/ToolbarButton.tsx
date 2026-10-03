import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';
import { BASE_BUTTON_STYLE, buttonVariants } from './Button';
import { Icon } from './Icon';
import { ButtonTooltip } from './Tooltip';

export function ToolbarButton({
  label,
  shortcut,
  children,
  active,
  dropdown = false,
  asChild = false,
  className,
  tooltipSide = 'bottom',
  variant,
  ...rest
}: React.ComponentProps<'button'> & {
  label: string;
  shortcut?: string;
  active?: boolean;
  dropdown?: boolean;
  asChild?: boolean;
  tooltipSide?: 'top' | 'bottom';
  variant?: 'danger-light';
}) {
  const Component = asChild ? Slot.Root : 'button';

  return (
    <ButtonTooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <Component
        aria-label={label}
        aria-pressed={active}
        className={cn(
          BASE_BUTTON_STYLE,
          'size-8 shrink-0 gap-1 px-0.5 text-fg [&_svg]:size-4',
          'focus-visible:ring-focus disabled:opacity-40',
          !variant &&
            'hover:bg-surface-hover-bg hover:text-fg [[data-floating-toolbar]_&]:hover:bg-overlay-hover',
          'data-[active=true]:bg-tint-accent-1/50 data-[active=true]:text-tint-accent-1-fg data-[active=true]:hover:bg-tint-accent-1/50',
          variant && buttonVariants({ size: null, variant }),
          dropdown && 'w-fit',
          className
        )}
        data-active={active}
        data-slot="button"
        data-variant={variant}
        type={asChild ? undefined : 'button'}
        {...rest}
      >
        {dropdown ? (
          <>
            {children}
            <Icon name="chevronDown" />
          </>
        ) : (
          children
        )}
      </Component>
    </ButtonTooltip>
  );
}
