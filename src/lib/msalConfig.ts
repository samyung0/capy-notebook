/** The Microsoft app OneDrive's picker signs in as, from the build. Apart from
 * MSAL (msalPickerAuth.ts), so Add file checks it before opening the picker's
 * window without loading MSAL. */
export function msalClientId(): string {
  const id = import.meta.env.VITE_MSAL_CLIENT_ID?.trim() ?? '';
  if (!id) throw new Error('MSAL_CONFIG');
  return id;
}

export function msalConfigured(): boolean {
  return !!import.meta.env.VITE_MSAL_CLIENT_ID?.trim();
}
