import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';

const iconButtonVariants = cva(
  "relative inline-flex cursor-pointer items-center justify-center p-2.5 transition-colors focus-visible:ring-2 focus-visible:ring-action disabled:pointer-events-none disabled:opacity-50",
  {
    defaultVariants: {
      size: "md",
      variant: "ghost",
    },
    variants: {
      size: {
        lg: "rounded-button [&>svg]:size-6",
        md: "rounded-button [&>svg]:size-5",
        sm: "rounded-button [&>svg]:size-4.25",
        xs: "rounded-button [&>svg]:size-3.5",
      },
      variant: {
        accent:
          "bg-action-accent text-action-accent-fg hover:bg-action-accent-hover",
        "accent-light":
          "bg-tint-accent-1 text-tint-accent-1-fg hover:bg-solid-accent-1/30",
        dark: "bg-action text-action-fg outline-offset-2 hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-action focus-visible:ring-0",
        "dark-gray": "bg-surface-dark text-fg hover:bg-surface-dark-hover-bg",
        ghost: "bg-surface text-fg",
        "ghost-hover": "bg-surface text-fg hover:bg-surface-hover-bg",
        gray: "bg-page text-fg hover:bg-surface-dark",
        neutral: "bg-surface text-surface-fg hover:bg-surface-hover-bg",
        outline:
          "border border-line bg-surface text-fg hover:bg-surface-hover-bg",
      },
    },
  },
);

// const SIZE = {
//   sm: 19,
//   md: 22,
//   lg: 24,
// };

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
      aria-label={label ?? rest["aria-label"]}
      className={cn(iconButtonVariants({ size, variant }), className)}
      data-size={size}
      data-slot="iconbutton"
      data-variant={variant}
      {...rest}
    >
      <Icon className={iconClassName} name={icon} strokeWidth={strokeWidth} />
      {children}
      {dot && (
        <span className="absolute animate-pulse top-2 right-2 h-1.5 w-1.5 rounded-full bg-solid-error ring-1 ring-surface" />
      )}
    </Tag>
  );
}
