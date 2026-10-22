import { SearchInput } from '@/components/ui/SearchInput';
import { m } from '@/i18n';

/** The search at the top of a workspace panel: filters the list below as you
 * type; the ✕ (shown while focused or filled) clears it. */
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
    <div className="shrink-0 px-2.5 pt-2.5 pb-1">
      <SearchInput
        // Clears and leaves the field, which hides the ✕ again.
        actionCallback={() => {
          onChange('');
          (document.activeElement as HTMLElement | null)?.blur();
        }}
        // Shown while focused or filled.
        actionClassName="hidden group-focus-within/search:inline-flex group-has-[input:not(:placeholder-shown)]/search:inline-flex"
        actionIcon="x"
        actionLabel={m.action_clear_search()}
        aria-label={label}
        maxLength={120}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        value={value}
      />
    </div>
  );
}

/** Case-insensitive substring match, as PanelSearch filters. */
export function matchesSearch(text: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || text.toLocaleLowerCase().includes(q);
}
