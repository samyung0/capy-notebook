export const SETTINGS_TABS = ['general', 'llm', 'subscription'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function parseSettingsSearch(search: Record<string, unknown>): {
  tab?: SettingsTab;
} {
  const tab = search.tab;
  if (tab === 'llm' || tab === 'subscription' || tab === 'general') {
    return { tab };
  }
  return {};
}

export function settingsTab(search: { tab?: SettingsTab }): SettingsTab {
  return search.tab ?? 'general';
}
