/** Router validateSearch for a page whose tabs live in `?tab=`. Unknown
 * values drop out, so the page falls back to its first tab. */
export function tabSearch<T extends string>(tabs: readonly T[]) {
  return (search: Record<string, unknown>): { tab?: T } =>
    tabs.includes(search.tab as T) ? { tab: search.tab as T } : {};
}

export const SETTINGS_TABS = [
  'account',
  'customizations',
  'study',
  'notifications',
  'llm',
  'danger',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const parseSettingsSearch = tabSearch(SETTINGS_TABS);

export const BILLING_TABS = ['usage', 'details', 'subscription'] as const;
export type BillingTab = (typeof BILLING_TABS)[number];
export const parseBillingSearch = tabSearch(BILLING_TABS);

export const LEARNING_TABS = ['progress', 'review', 'past', 'results'] as const;
export type LearningTab = (typeof LEARNING_TABS)[number];
export const parseLearningSearch = tabSearch(LEARNING_TABS);

export const FILES_TABS = ['files', 'blocks', 'trash'] as const;
export type FilesTab = (typeof FILES_TABS)[number];
