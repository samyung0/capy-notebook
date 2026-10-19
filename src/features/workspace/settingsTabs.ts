/** Workspace settings tabs, also the workspace URL's `settings` value. */
export const SETTINGS_TABS = [
  'general',
  'sharing',
  'indexing',
  'statistics',
  'others',
  'danger',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const isSettingsTab = (value: unknown): value is SettingsTab =>
  SETTINGS_TABS.some((tab) => tab === value);
