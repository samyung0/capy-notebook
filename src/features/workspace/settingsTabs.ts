/** Workspace settings tabs, also the workspace URL's `settings` value. */
export const SETTINGS_TABS = [
  'general',
  'sharing',
  'indexing',
  'statistics',
  'study',
  'others',
  'danger',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** `settings=menu` opens Workspace settings with no tab picked: phones show the
 * tab list, wider screens the first tab. */
export type SettingsView = SettingsTab | 'menu';

export const isSettingsView = (value: unknown): value is SettingsView =>
  value === 'menu' || SETTINGS_TABS.some((tab) => tab === value);
