import type { SourceProvider } from './sourceTransfers';

/* Connecting a drive sends the whole tab through the provider's consent
 * screen and back, which drops the dialog. The workspace page reopens it on
 * Import from this marker, and Google's in-page picker opens by itself.
 * OneDrive's picker is a popup, so it still needs a click. */
const CONNECT_RESUME_KEY = 'capy:connect-resume';

/** The provider to resume on this destination; null `workspaceId` is No
 * workspace, which the Files page reopens. */
export function resumedConnect(
  workspaceId: string | null
): SourceProvider | null {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(CONNECT_RESUME_KEY) ?? 'null'
    ) as { provider: SourceProvider; workspaceId: string | null } | null;
    return saved && saved.workspaceId === workspaceId ? saved.provider : null;
  } catch {
    return null;
  }
}

export function setConnectResume(
  value: { provider: SourceProvider; workspaceId: string | null } | null
) {
  try {
    if (value)
      sessionStorage.setItem(CONNECT_RESUME_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(CONNECT_RESUME_KEY);
  } catch {
    /* Storage blocked: the user clicks Import again after the redirect. */
  }
}
