import { cn } from '@/lib/cn';

type Tab = string | { value: string; label: string };

export interface TabsProps {
  bottomBorder?: boolean;
  className?: string;
  onChange?: (value: string) => void;
  tabs: Tab[];
  value: string;
}

const norm = (t: Tab) => (typeof t === 'string' ? { label: t, value: t } : t);

export function Tabs({
  tabs,
  value,
  onChange,
  className,
  bottomBorder = true,
}: TabsProps) {
  return (
    <div
      className={cn(
        'flex w-full gap-1',
        bottomBorder && 'border-divider border-b',
        className
      )}
    >
      {tabs.map((tab) => {
        const t = norm(tab);
        const active = t.value === value;
        return (
          <button
            className={cn(
              '-mb-px px-3 py-2 font-semibold text-sm transition-colors',
              bottomBorder && 'border-b-2',
              active
                ? 'border-action font-bold text-fg'
                : 'border-transparent text-fg-muted hover:text-fg'
            )}
            key={t.value}
            onClick={() => onChange?.(t.value)}
            type="button"
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
