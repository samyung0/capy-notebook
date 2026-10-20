import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';

/** The underline search at the top of a workspace panel (the question bank
 * panel's field): filters the list below as you type; the ✕ clears it. */
export function PanelSearch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="shrink-0 px-2.5 pb-1">
      <Input
        actionCallback={() => onChange('')}
        actionClassName="p-1.5 text-fg-muted"
        actionIcon={value ? 'x' : undefined}
        actionLabel={m.action_clear_search()}
        aria-label={label}
        leftIcon="search"
        leftIconClassName="-translate-y-px"
        maxLength={120}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        value={value}
        variant="underline"
        wrapperClassName="h-9 w-full gap-2.5 px-2 text-sm"
      />
    </div>
  );
}

/** Case-insensitive substring match, as PanelSearch filters. */
export function matchesSearch(text: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || text.toLocaleLowerCase().includes(q);
}
