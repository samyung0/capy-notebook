import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

type Option = string | { value: string; label: string };

const segmentedVariants = cva('inline-flex p-[3px]', {
  defaultVariants: {
    variant: 'solid',
  },
  variants: {
    variant: {
      ghost: 'rounded-row',
      solid: 'rounded-pill border border-line bg-surface',
    },
  },
});

const segmentVariants = cva('font-semibold transition-colors', {
  defaultVariants: {
    active: false,
    size: 'md',
    variant: 'solid',
  },
  variants: {
    active: {
      false: 'bg-transparent text-fg-muted hover:text-fg',
      true: 'bg-action text-action-fg shadow-chip',
    },
    size: {
      md: 'px-[19px] py-[11px] text-sm',
      sm: 'px-[15px] py-2 text-[12.5px]',
    },
    variant: {
      ghost: 'rounded-card-lg',
      solid: 'rounded-pill',
    },
  },
});

export interface SegmentedControlProps
  extends VariantProps<typeof segmentedVariants> {
  className?: string;
  onChange?: (value: string) => void;
  options: Option[];
  size?: 'sm' | 'md';
  value: string;
}

const norm = (o: Option) =>
  typeof o === 'string' ? { label: o, value: o } : o;

export function SegmentedControl({
  options,
  value,
  onChange,
  size = 'md',
  variant = 'solid',
  className,
}: SegmentedControlProps) {
  return (
    <div className={cn(segmentedVariants({ variant }), className)}>
      {options.map((opt) => {
        const o = norm(opt);
        const active = o.value === value;
        return (
          <button
            className={segmentVariants({ active, size, variant })}
            key={o.value}
            onClick={() => onChange?.(o.value)}
            type="button"
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
