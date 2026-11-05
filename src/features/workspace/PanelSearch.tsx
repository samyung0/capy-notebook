import { SearchInput } from '@/components/ui/SearchInput';
import { m } from '@/i18n';

type PanelSearchProps = {
  value: string;
  onChange: (value: string) => void;
  label: string;
};

/** The search at the top of a workspace panel, in its gutter. */
export function PanelSearch(props: PanelSearchProps) {
  return (
    <div className="shrink-0 px-2.5 pt-2.5 pb-1">
      <PanelSearchField {...props} />
    </div>
  );
}

/** The file tree's search field: filters a list as you type; the ✕ (shown while
 * focused or filled) clears it. */
export function PanelSearchField({ value, onChange, label }: PanelSearchProps) {
  return (
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
  );
}

/** Case-insensitive substring match, as PanelSearch filters. */
export function matchesSearch(text: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || text.toLocaleLowerCase().includes(q);
}
