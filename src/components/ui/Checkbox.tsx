import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';

const checkboxVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[7px] border transition-colors',
  {
    compoundVariants: [
      {
        checked: true,
        class: 'border-action bg-action text-action-fg',
        tone: 'dark',
      },
      {
        checked: true,
        class: 'border-solid-info bg-solid-info text-white',
        tone: 'blue',
      },
      {
        checked: true,
        class: 'border-solid-success bg-solid-success text-white',
        tone: 'green',
      },
      {
        checked: true,
        class: 'border-accent bg-action-accent text-action-accent-fg',
        tone: 'purple',
      },
    ],
    defaultVariants: {
      checked: false,
      tone: 'dark',
    },
    variants: {
      checked: {
        false: 'border-line-strong bg-surface',
        true: '',
      },
      tone: {
        blue: '',
        dark: '',
        green: '',
        purple: '',
      },
    },
  }
);

export interface CheckboxProps extends VariantProps<typeof checkboxVariants> {
  checked?: boolean;
  className?: string;
  onChange?: (checked: boolean) => void;
  size?: number;
}

export function Checkbox({
  checked = false,
  onChange,
  size = 20,
  tone = 'dark',
  className,
}: CheckboxProps) {
  return (
    <button
      aria-checked={checked}
      className={cn(checkboxVariants({ checked, tone }), className)}
      data-slot="checkbox"
      data-tone={tone}
      onClick={() => onChange?.(!checked)}
      role="checkbox"
      style={{ height: size, width: size }}
      type="button"
    >
      {checked && <Icon name="check" size={size * 0.72} strokeWidth={2.4} />}
    </button>
  );
}
