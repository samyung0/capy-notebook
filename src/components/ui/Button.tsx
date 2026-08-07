import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';

export const BASE_BUTTON_STYLE =
  'inline-flex relative rounded-button min-w-0 text-sm cursor-pointer select-none items-center justify-center whitespace-nowrap font-semibold leading-none outline-none transition-all duration-150 ease-out focus-visible:ring-2 focus-visible:ring-action active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50';

const buttonVariants = cva(BASE_BUTTON_STYLE, {
  defaultVariants: {
    size: 'md',
    variant: 'dark',
  },
  variants: {
    size: {
      lg: 'h-13 min-w-24 gap-2.25 rounded-full px-6.5 text-[0.925rem]',
      md: 'h-11 gap-2 px-5',
      sm: 'h-7.5 gap-1.75 px-4',
      xs: 'h-fit gap-1.5 px-0.5 py-0.5',
    },
    variant: {
      accent:
        'border border-transparent bg-action-accent text-action-accent-fg hover:bg-action-accent-hover',
      danger:
        'border border-transparent bg-solid-error text-surface hover:brightness-95',
      dark: 'border border-transparent bg-action text-action-fg outline-offset-2 hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-action focus-visible:ring-0',
      ghost: 'border-none',
      'ghost-hover': 'border-none text-fg hover:bg-surface-hover-bg/80',
      'ghost-link': 'border-none text-link hover:text-link-hover',
      'ghost-muted': 'border-none text-fg-muted hover:text-fg/80',
      outline:
        'border border-line bg-surface text-fg hover:bg-surface-hover-bg/80',
      surface:
        'border border-transparent bg-surface text-fg hover:bg-surface-hover-bg',
    },
  },
});

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export interface ButtonProps
  extends React.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  fullWidth?: boolean;
  iconLeft?: IconName;
  iconRight?: IconName;
}

const InlineIcon = ({
  name,
  size,
}: {
  name: IconName;
  size: VariantProps<typeof buttonVariants>['size'];
}) => (
  <Icon
    className={cn(
      'pointer-events-none shrink-0 -translate-y-px',
      size === 'sm' && 'size-3.75',
      size === 'md' && 'size-4',
      size === 'lg' && 'size-4.5'
    )}
    name={name}
  />
);

export function Button({
  children,
  variant = 'dark',
  size = 'md',
  iconLeft,
  iconRight,
  fullWidth,
  className,
  asChild = false,
  ...rest
}: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root
        className={cn(
          cn(buttonVariants({ size, variant })),
          fullWidth && 'w-full',
          className
        )}
        data-size={size}
        data-slot="button"
        data-variant={variant}
        {...rest}
      >
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      className={cn(
        buttonVariants({ size, variant }),
        fullWidth && 'w-full',
        className
      )}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...rest}
    >
      {iconLeft && <InlineIcon name={iconLeft} size={size} />}
      {children}
      {iconRight && <InlineIcon name={iconRight} size={size} />}
    </button>
  );
}
