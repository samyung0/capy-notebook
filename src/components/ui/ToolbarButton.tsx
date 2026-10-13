import { Slot } from '@radix-ui/react-slot';
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
  tooltip = true,
  variant,
  ...rest
}: React.ComponentProps<'button'> & {
  label: string;
  shortcut?: string;
  active?: boolean;
  dropdown?: boolean;
  asChild?: boolean;
  tooltipSide?: 'top' | 'bottom';
  /** Off where the label only repeats text already on screen. */
  tooltip?: boolean;
  variant?: 'danger-light';
}) {
  const Component = asChild ? Slot : 'button';

  const button = (
    <Component
      aria-label={label}
      aria-pressed={active}
      className={cn(
        BASE_BUTTON_STYLE,
        'size-(--toolbar-button) shrink-0 gap-1 px-0.5 text-fg [&_svg]:size-(--toolbar-icon)',
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
  );
  return tooltip ? (
    <ButtonTooltip label={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </ButtonTooltip>
  ) : (
    button
  );
}
