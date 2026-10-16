/**
 * The release nudge and the version gate's Reload (Epo 2026-10-16, the nudge
 * source 2026-10-17). The build writes its release to `/release.txt`, served
 * uncached; when the tab regains focus it reads that file, and another release
 * makes the next page change a full page load, once per served release per
 * tab (a stale edge cannot loop it), with nothing shown. A room join or draft
 * send refused for the client protocol marks the update too.
 */
const RELEASE = import.meta.env.VITE_RELEASE_SHA as string | undefined;
/** The last `<own release>><served release>` this tab loaded for. */
const LOADED_KEY = 'capy-update-load';
/** A deploy's revision (scripts/env/config.py). Anything else, such as the
 * SPA fallback's HTML where no release file is served, is no release. */
const REVISION = /^[0-9a-f]{40}$/;
/** Focus checks are at most this far apart. */
const CHECK_INTERVAL_MS = 60_000;

// The release a newer app is served under (`unknown` when only a refusal
// said so), or null while this build is current.
let available: string | null = null;
let lastCheck = Number.NEGATIVE_INFINITY;

/** The release the site serves now, or undefined when the check fails or
 * finds none. */
async function servedRelease(): Promise<string | undefined> {
  try {
    const response = await fetch('/release.txt', { cache: 'no-store' });
    const served = (await response.text()).trim();
    return response.ok && REVISION.test(served) ? served : undefined;
  } catch {}
}

/** Reads the served release, at most once a minute; another release than
 * this build's marks the update. A build without a release (local dev, MSW)
 * reads nothing. */
export async function checkServedRelease() {
  if (!RELEASE || Date.now() - lastCheck < CHECK_INTERVAL_MS) return;
  lastCheck = Date.now();
  const served = await servedRelease();
  if (served && served !== RELEASE) available = served;
}

/** Checks the served release whenever the tab becomes visible or focused. */
export function checkReleaseOnFocus() {
  const check = () => {
    if (document.visibilityState === 'visible') void checkServedRelease();
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
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
 * scroll to a `#fragment`). Offline the page stays: a load would land on the
 * browser's offline page, so the first path change back online loads. */
export function loadUpdateOnPathChange(router: {
  subscribe: (
    event: 'onBeforeNavigate',
    listener: (event: { pathChanged: boolean }) => void
  ) => () => void;
}) {
  return router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (pathChanged && navigator.onLine && takeUpdateLoad())
      window.location.reload();
  });
}

/**
 * The outdated strip's Reload: loads the page once the site serves another
 * release than this tab's, else resolves false (the new app is still being
 * published, or the check failed).
 */
export async function reloadIntoNewRelease(): Promise<boolean> {
  const served = await servedRelease();
  if (!served || served === RELEASE) return false;
  window.location.reload();
  return true;
}
