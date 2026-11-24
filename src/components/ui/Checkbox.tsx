import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';

export const checkboxVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors',
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
  'aria-label'?: string;
  checked?: boolean;
  className?: string;
  onChange?: (checked: boolean) => void;
  size?: number;
}

export function Checkbox({
  'aria-label': ariaLabel,
  checked = false,
  onChange,
  size = 20,
  tone = 'dark',
  className,
}: CheckboxProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
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

/** A row that is its own checkbox: a click, Space or Enter anywhere on it
 * toggles it (From question bank's rows and cards, Make a quiz's Select all). */
export function CheckRow({
  boxClassName,
  checked,
  children,
  className,
  disabled,
  onChange,
}: {
  /** Nudges the box to the row's first line. */
  boxClassName?: string;
  checked: boolean;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const toggle = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    <div
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      className={cn(
        'flex items-start gap-3 border-divider border-b px-1 py-3 outline-none',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'cursor-pointer hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg',
        className
      )}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        toggle();
      }}
      role="checkbox"
      tabIndex={0}
    >
      <CheckBox checked={checked} className={cn('mt-0.5', boxClassName)} />
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
    </div>
  );
}

/** The box alone, for a control that is already the checkbox or button. */
export function CheckBox({
  checked,
  className,
}: {
  checked: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(checkboxVariants({ checked }), 'size-4.5', className)}
    >
      {checked && <Icon name="check" size={13} strokeWidth={2.4} />}
    </span>
  );
}
