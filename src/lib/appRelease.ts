/**
 * The release nudge and the version gate's Reload (Epo 2026-10-16). The site
 * Worker stamps the SPA release it serves on every /api response
 * (`X-Capy-App-Release`); when that differs from this build's, the next page
 * change is a full page load, once per served release per tab (a stale edge
 * cannot loop it), with nothing shown. A room join or draft send refused
 * for the client protocol marks the update too.
 */
const RELEASE = import.meta.env.VITE_RELEASE_SHA as string | undefined;
export const APP_RELEASE_HEADER = 'X-Capy-App-Release';
/** The last `<own release>><served release>` this tab loaded for. */
const LOADED_KEY = 'capy-update-load';
/** index.html's `<meta name="capy-release">` (scripts/deploy/verify-release.sh
 * reads it too). */
const RELEASE_META = /<meta\b[^>]*\bname="capy-release"[^>]*>/;
const CONTENT = /\bcontent="([^"]*)"/;

// The release a newer app is served under (`unknown` when only a refusal
// said so), or null while this build is current.
let available: string | null = null;

/** Reads the served release off an /api response. */
export function noteServedRelease(headers: Headers) {
  const served = headers.get(APP_RELEASE_HEADER);
  if (served && RELEASE && served !== RELEASE) available = served;
}

/** This build's client protocol was refused (an editor's or reader's room,
 * a draft send): a newer app is served or about to be. */
export function markUpdateAvailable() {
  available ??= 'unknown';
}

/** Whether this page change should load the page instead: an update is
 * available and this tab has not loaded for it yet. */
export function takeUpdateLoad(): boolean {
  if (!available) return false;
  const key = `${RELEASE}>${available}`;
  try {
    if (sessionStorage.getItem(LOADED_KEY) === key) return false;
    sessionStorage.setItem(LOADED_KEY, key);
  } catch {
    // Without the guard a stale edge could loop the load.
    return false;
  }
  return true;
}

/** Makes the next path change a full page load once an update is available
 * (`?file=` and other search changes stay in the page). The router has
 * already pushed the new URL, so a reload loads it (assigning it would only
 * scroll to a `#fragment`). */
export function loadUpdateOnPathChange(router: {
  subscribe: (
    event: 'onBeforeNavigate',
    listener: (event: { pathChanged: boolean }) => void
  ) => () => void;
}) {
  return router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (pathChanged && takeUpdateLoad()) window.location.reload();
  });
}

/**
 * The outdated strip's Reload: loads the page once the site serves another
 * release than this tab's, else resolves false (the new app is still being
 * published, or the check failed).
 */
export async function reloadIntoNewRelease(): Promise<boolean> {
  let served: string | undefined;
  try {
    const response = await fetch('/', { cache: 'no-store' });
    const meta = RELEASE_META.exec(await response.text())?.[0];
    served = meta && CONTENT.exec(meta)?.[1];
  } catch {
    return false;
  }
  if (!served || served === RELEASE) return false;
  window.location.reload();
  return true;
}
