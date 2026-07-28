import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';

const buttonVariants = cva(
  "inline-flex min-w-0 text-sm cursor-pointer select-none items-center justify-center whitespace-nowrap font-semibold leading-none outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-action active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: {
      size: "md",
      variant: "primary",
    },
    variants: {
      size: {
        lg: "gap-2.25 rounded-card px-6.5 py-5 ",
        md: "gap-2 rounded-button px-5 py-3",
        sm: "gap-1.75 rounded-button px-4 py-2.5",
      },
      variant: {
        accent:
          "border border-transparent bg-action-accent text-action-accent-fg hover:bg-action-accent-hover",
        danger:
          "border border-transparent bg-solid-error text-surface hover:brightness-95",
        ghost: "border-none text-fg",
        "ghost-hover": "border-none text-fg hover:bg-surface-hover-bg/80",
        "ghost-link": "border-none text-link hover:text-link-hover",
        gray: "bg-surface-hover-bg text-surface-dark-fg hover:bg-surface-dark",
        outline:
          "border border-line bg-surface text-fg hover:bg-surface-hover-bg/80",
        primary:
          "border border-transparent bg-action text-action-fg outline-offset-2 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-action focus-visible:ring-0",
        surface:
          "border border-transparent bg-surface text-fg hover:bg-surface-hover-bg",
      },
    },
  },
);

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
  variant = 'primary',
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
