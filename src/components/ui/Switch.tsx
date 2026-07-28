import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked?: boolean;
  className?: string;
  onChange?: (checked: boolean) => void;
}

export function Switch({ checked = false, onChange, className }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      className={cn(
        "relative h-6 w-10 rounded-full transition-colors",
        checked ? "bg-action" : "bg-line-strong",
        className,
      )}
      onClick={() => onChange?.(!checked)}
      role="switch"
      type="button"
    >
      <span
        className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-[left] duration-150"
        style={{ left: checked ? 19 : 3 }}
      />
    </button>
  );
}
