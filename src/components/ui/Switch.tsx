import { cn } from '@/lib/cn';

export interface SwitchProps {
  'aria-label'?: string;
  checked?: boolean;
  className?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

export function Switch({
  'aria-label': ariaLabel,
  checked = false,
  className,
  disabled = false,
  onChange,
}: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cn(
        'relative h-6 w-10 rounded-full transition-colors',
        checked ? 'bg-action' : 'bg-line-strong',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      role="switch"
      type="button"
    >
      <span
        className="absolute top-0.75 h-4.5 w-4.5 rounded-full bg-white transition-[left] duration-150"
        style={{ left: checked ? 19 : 3 }}
      />
    </button>
  );
}
