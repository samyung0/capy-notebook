import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ElementType } from 'react';
import { cn } from '@/lib/cn';

const cardVariants = cva('flex flex-col items-stretch gap-2 p-5.5', {
  defaultVariants: {
    border: 'none',
    radius: 'card',
    theme: 'surface',
  },
  variants: {
    border: {
      dashed: 'border-[1.5px] border-line-strong border-dashed',
      none: '',
      solid: 'border border-line',
    },
    radius: {
      button: 'rounded-button',
      card: 'rounded-card',
      'card-lg': 'rounded-card-lg',
      'card-xl': 'rounded-card-xl',
      none: 'rounded-none',
      panel: 'rounded-card-lg',
      row: 'rounded-button',
      unset: '',
    },
    theme: {
      page: 'bg-page text-fg',
      surface: 'bg-surface text-fg transition-colors hover:bg-surface-hover-bg',
      'surface-dark': 'bg-surface-dark text-fg hover:bg-surface-dark-hover-bg',
      transparent: 'bg-transparent text-fg',
    },
  },
});

export interface CardProps
  extends React.ComponentProps<'div'>,
    VariantProps<typeof cardVariants> {
  asChild?: boolean;
  hoverBackgroundColorChange?: boolean;
  interactive?: boolean;
  raised?: boolean;
}

export function Card({
  radius = 'card',
  theme = 'surface',
  border = 'none',
  hoverBackgroundColorChange = false,
  interactive,
  raised,
  className,
  style,
  asChild,
  ...rest
}: CardProps) {
  const Tag = (asChild ? Slot.Root : 'div') as ElementType;
  return (
    <Tag
      className={cn(
        cardVariants({ border, radius, theme }),
        raised && 'bg-overlay shadow-pop',
        interactive &&
          // transitions.dev Avatar group hover: a direct lift, a bouncy return.
          'cursor-pointer transition-all duration-320 ease-(--motion-ease-bounce-strong) hover:-translate-y-1 hover:shadow-card hover:ease-(--motion-ease-smooth-out) active:scale-[0.98] active:duration-100',
        (!hoverBackgroundColorChange || !interactive) && 'hover:bg-unset', //todo
        className
      )}
      data-border={border}
      data-radius={radius}
      data-slot="card"
      data-theme={theme}
      style={{ ...style }}
      {...rest}
    />
  );
}
