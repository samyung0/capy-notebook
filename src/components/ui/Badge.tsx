import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-pill font-bold leading-none',
  {
    variants: {
      size: {
        lg: 'px-3 py-2 text-sm',
        md: 'px-2.5 py-1.5 text-xs',
        sm: 'px-2 py-0.5 text-xs',
      },
      tone: {
        'accent-1': 'bg-tint-accent-1 text-tint-accent-1-fg',
        'accent-2': 'bg-tint-accent-2 text-tint-accent-2-fg',
        dark: 'bg-action text-action-fg',
        error: 'bg-tint-error text-tint-error-fg',
        info: 'bg-tint-info text-tint-info-fg',
        neutral: 'bg-page text-surface-fg',
        success: 'bg-tint-success text-tint-success-fg',
        warning: 'bg-tint-warning text-tint-warning-fg',
      },
    },
  }
);

export interface BadgeProps
  extends React.ComponentProps<'span'>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
  uppercase?: boolean;
}

export function Badge({
  tone = 'neutral',
  size = 'md',
  uppercase,
  className,
  asChild,
  ...rest
}: BadgeProps) {
  const Tag = (asChild ? Slot.Root : 'span') as React.ElementType;
  return (
    <Tag
      className={cn(
        badgeVariants({ size, tone }),
        uppercase && 'uppercase tracking-[0.06em]',
        className
      )}
      {...rest}
    />
  );
}
