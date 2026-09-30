/** Router validateSearch for a page whose tabs live in `?tab=`. Unknown
 * values drop out, so the page falls back to its first tab. */
export function tabSearch<T extends string>(tabs: readonly T[]) {
  return (search: Record<string, unknown>): { tab?: T } =>
    tabs.includes(search.tab as T) ? { tab: search.tab as T } : {};
}

export const SETTINGS_TABS = [
  'account',
  'customizations',
  'notifications',
  'llm',
  'danger',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const parseSettingsSearch = tabSearch(SETTINGS_TABS);

export const BILLING_TABS = ['usage', 'details', 'subscription'] as const;
export type BillingTab = (typeof BILLING_TABS)[number];
export const parseBillingSearch = tabSearch(BILLING_TABS);
