import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';
import { BASE_BUTTON_STYLE } from './Button';
import { Icon, type IconName } from './Icon';

const iconButtonVariants = cva(BASE_BUTTON_STYLE, {
  defaultVariants: {
    size: 'md',
    variant: 'ghost',
  },
  variants: {
    size: {
      lg: 'p-2.5 [&>svg]:size-6',
      md: 'p-2.5 [&>svg]:size-5',
      sm: 'p-2.5 [&>svg]:size-4.25',
      xs: 'p-1 [&>svg]:size-3.5',
    },
    variant: {
      accent:
        'bg-action-accent text-action-accent-fg hover:bg-action-accent-hover',
      'accent-light':
        'bg-tint-accent-1 text-tint-accent-1-fg hover:bg-solid-accent-1/30',
      dark: 'bg-action text-action-fg outline-offset-2 hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-action focus-visible:ring-0',
      ghost: 'bg-transparent text-fg',
      'ghost-hover': 'bg-transparent text-fg hover:bg-surface-hover-bg',
      outline:
        'border border-line bg-surface text-fg hover:bg-surface-hover-bg',
      page: 'bg-page text-fg hover:bg-page-hover',
      surface: 'bg-surface text-fg hover:bg-surface-hover-bg',
      'surface-dark': 'bg-surface-dark text-fg hover:bg-surface-dark-hover-bg',
    },
  },
});

export interface IconButtonProps
  extends React.ComponentProps<'button'>,
    VariantProps<typeof iconButtonVariants> {
  asChild?: boolean;
  dot?: boolean;
  icon: IconName;
  iconClassName?: string;
  label?: string;
  strokeWidth?: number;
}

export function IconButton({
  icon,
  variant,
  size,
  dot,
  strokeWidth,
  label,
  children,
  className,
  iconClassName,
  ...rest
}: IconButtonProps) {
  const Tag = rest.asChild ? Slot.Root : 'button';
  return (
    <Tag
      aria-label={label ?? rest['aria-label']}
      className={cn(iconButtonVariants({ size, variant }), className)}
      data-size={size}
      data-slot="iconbutton"
      data-variant={variant}
      {...rest}
    >
      <Icon className={iconClassName} name={icon} strokeWidth={strokeWidth} />
      {children}
      {dot && (
        <span className="absolute top-1.75 right-1.75 h-1.5 w-1.5 animate-pulse rounded-full bg-solid-error ring-1 ring-surface" />
      )}
    </Tag>
  );
}
