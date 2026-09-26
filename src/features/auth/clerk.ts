import { m } from '@/i18n';

/** Message shown under a field for a Clerk custom-flow result. Structural so
 * the file does not depend on @clerk/shared, which is not a direct dependency. */
export function clerkMessage(
  error: { message: string; longMessage?: string } | null | undefined
): string {
  if (!error) return m.auth_error_generic();
  return error.longMessage || error.message || m.auth_error_generic();
}

/** Sign-in page URL that returns to `returnTo` (a same-origin path) after auth. */
export function signInHref(
  returnTo = `${window.location.pathname}${window.location.search}`
) {
  const path =
    returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  return `/sign-in?${new URLSearchParams({ redirect_url: path })}`;
}

/** Same-origin return path after auth, from the `redirect_url` query. A path
 * or an absolute URL reduces to path, search and hash on this origin, anything
 * else to `/`. */
export function redirectAfterAuth(): string {
  const raw = new URLSearchParams(window.location.search).get('redirect_url');
  if (!raw) return '/';
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return '/';
  }
  if (url.origin !== window.location.origin) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

export const SSO_CALLBACK_PATH = '/sso-callback';

/** Absolute URLs for Clerk's SSO redirects; the target survives the round trip. */
export function ssoUrls(target: string) {
  const { origin } = window.location;
  return {
    redirectCallbackUrl: `${origin}${SSO_CALLBACK_PATH}?${new URLSearchParams({ redirect_url: target })}`,
    redirectUrl: `${origin}${target}`,
  };
}
