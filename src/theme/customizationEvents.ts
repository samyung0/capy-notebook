/** As /api/me returns it; ThemeProvider checks each field before using it. */
export type SyncedCustomization = {
  pageFrame: unknown;
  style: string;
  theme: string;
};

type Listener = (customization: SyncedCustomization) => void;
const listeners = new Set<Listener>();

/** Another device synced its look: the event stream refetched /api/me and
 * hands the account's customization to ThemeProvider, which adopts it. */
export function onSyncedCustomization(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitSyncedCustomization(customization: SyncedCustomization) {
  for (const listener of listeners) listener(customization);
}
