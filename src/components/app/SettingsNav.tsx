import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import { matchesSearch, PanelSearch } from '@/features/workspace/PanelSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useDebounced } from '@/lib/useDebounced';

export type SettingsNavTab<T extends string> = {
  icon: IconName;
  label: string;
  /** The settings it holds, for the search. */
  terms: string[];
  tone?: 'danger';
  value: T;
};

/** A settings page's search and the tabs under it. The search narrows the tabs
 * to those holding a match, naming the setting under its tab; the tab open
 * stays open whatever it finds. Phones show the tabs as one card of rows, each
 * with its icon and an arrow, a divider starting after the icon. */
export function SettingsNav<T extends string>({
  className,
  label,
  onChange,
  onQueryChange,
  query,
  tabs,
  value,
}: {
  className?: string;
  label: string;
  onChange: (value: T) => void;
  onQueryChange?: (query: string) => void;
  query?: string;
  tabs: SettingsNavTab<T>[];
  value: string;
}) {
  const [search, setSearch] = useState(query ?? '');
  const settled = useDebounced(search.trim());
  // Only what was typed since: opening from a link writes nothing back.
  const sent = useRef(settled);
  useEffect(() => {
    if (settled === sent.current) return;
    sent.current = settled;
    onQueryChange?.(settled);
  }, [settled, onQueryChange]);
  const shown = tabs.flatMap((tab) => {
    const inLabel = matchesSearch(tab.label, search);
    const match = inLabel
      ? undefined
      : tab.terms.find((term) => matchesSearch(term, search));
    return inLabel || match
      ? [
          {
            label: (
              <span className="flex items-stretch sm:block">
                <span className="flex w-12 shrink-0 items-center justify-center sm:hidden">
                  <Icon name={tab.icon} size={20} />
                </span>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2 border-divider border-b py-3 pr-3.5 group-last/tab:border-b-0 sm:block sm:border-b-0 sm:p-0">
                  <span className="block min-w-0">
                    <span className="block">{tab.label}</span>
                    {match && (
                      <span className="t-meta block font-normal text-fg-muted">
                        {match}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-fg-muted sm:hidden">
                    <Icon name="navigationForward" />
                  </span>
                </span>
              </span>
            ),
            tone: tab.tone,
            value: tab.value,
          },
        ]
      : [];
  });
  return (
    <nav aria-label={label} className={cn('flex shrink-0 flex-col', className)}>
      {/* PanelSearch pads itself for a panel; here the field lines up with the
          tabs. */}
      <div className="-mx-2.5 -mt-2.5">
        <PanelSearch
          label={m.workspace_settings_search()}
          onChange={setSearch}
          value={search}
        />
      </div>
      {shown.length > 0 ? (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto sm:mt-2">
          <Tabs
            onChange={(next) => onChange(next as T)}
            orientation="vertical"
            tabs={shown}
            value={value}
          />
        </div>
      ) : (
        <p className="t-meta mt-3 px-3.5 text-fg-muted">
          {m.workspace_settings_no_match()}
        </p>
      )}
    </nav>
  );
}
