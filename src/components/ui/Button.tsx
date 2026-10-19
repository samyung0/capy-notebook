import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';

export const BASE_BUTTON_STYLE =
  'inline-flex relative rounded-button min-w-0 text-sm cursor-pointer select-none items-center justify-center whitespace-nowrap font-semibold leading-none outline-none transition-all duration-150 ease-out focus-visible:ring-2 focus-visible:ring-action active:scale-[0.96] data-pressed:scale-[0.96] disabled:pointer-events-none disabled:opacity-50';

export const buttonVariants = cva(BASE_BUTTON_STYLE, {
  // Radius classes live here because compound classes come after every
  // variant's, so they override the size's radius (lg is a pill).
  compoundVariants: [
    { class: 'rounded-button-lg', rounded: 'large' },
    { class: 'rounded-button', rounded: 'normal' },
  ],
  defaultVariants: {
    size: 'md',
    variant: 'dark',
  },
  variants: {
    /** Unset keeps the size's radius. */
    rounded: {
      large: '',
      normal: '',
    },
    // lg and md are 4px shorter on phones, matching Select. The height goes
    // through a variable so one h-* override (h-fit, size-10) still replaces it.
    size: {
      lg: 'h-(--button-h) min-w-24 gap-2.25 rounded-full px-6.5 text-[0.925rem] [--button-h:--spacing(12)] sm:[--button-h:--spacing(13)]',
      md: 'h-(--button-h) gap-2 px-5 [--button-h:--spacing(10)] sm:[--button-h:--spacing(11)]',
      sm: 'h-7.5 gap-1.75 px-4',
      xs: 'h-fit gap-1.5 px-0.5 py-0.5',
    },
    variant: {
      accent:
        'border border-transparent bg-action-accent text-action-accent-fg hover:bg-action-accent-hover',
      danger:
        'border border-transparent bg-solid-error text-surface hover:brightness-95',
      'danger-light':
        'border border-transparent text-tint-error-fg hover:bg-tint-error/85',
      // Bordered, for a destructive action that stays on the page.
      'danger-outline':
        'border border-line bg-surface text-tint-error-fg hover:bg-tint-error/85',
      dark: 'border border-transparent bg-action text-action-fg outline-offset-2 hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-action focus-visible:ring-0',
      ghost: 'border-none',
      'ghost-hover': 'border-none text-fg hover:bg-surface-hover-bg/80',
      'ghost-link': 'border-none text-link hover:text-link-hover',
      'ghost-muted': 'border-none text-fg-muted hover:text-fg',
      gray: 'border border-transparent bg-page text-fg hover:bg-page-hover',
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
  iconLeftClassName?: string;
  iconRight?: IconName;
  iconRightClassName?: string;
}

/** Shared recovery action: a retry with the refresh icon after the label, or
 * with `back` a way out with the back arrow before it. */
export function ErrorAction({
  back,
  className,
  ...props
}: Omit<
  ButtonProps,
  | 'variant'
  | 'iconLeft'
  | 'iconLeftClassName'
  | 'iconRight'
  | 'iconRightClassName'
> & { back?: boolean }) {
  return (
    <Button
      className={cn('font-bold', className)}
      iconLeft={back ? 'navigationBack' : undefined}
      iconLeftClassName="me-1"
      iconRight={back ? undefined : 'refresh'}
      iconRightClassName="ms-1"
      variant="ghost-hover"
      {...props}
    />
  );
}

/** Icon's default 18px at every button size, the smallest icon a button carries. */
const InlineIcon = ({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) => (
  <Icon
    className={cn('pointer-events-none shrink-0 -translate-y-px', className)}
    name={name}
  />
);

export function Button({
  children,
  variant = 'dark',
  size = 'md',
  rounded,
  iconLeft,
  iconRight,
  fullWidth,
  className,
  iconLeftClassName,
  iconRightClassName,
  asChild = false,
  ...rest
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      className={cn(
        buttonVariants({ rounded, size, variant }),
        fullWidth && 'w-full',
        className
      )}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...rest}
    >
      <Slottable child={children}>
        {(content) => (
          <>
            {iconLeft && (
              <InlineIcon className={iconLeftClassName} name={iconLeft} />
            )}
            {content}
            {iconRight && (
              <InlineIcon className={iconRightClassName} name={iconRight} />
            )}
          </>
        )}
      </Slottable>
    </Component>
  );
}
