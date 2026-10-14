/* PostHog's hosts, read the same way by the browser client
   (src/lib/analytics.ts) and the public pages' script policy
   (vite-image-policy.ts). */

const US_CLOUD = /https:\/\/(app|us|us-assets)(\.i)?\.posthog\.com/i;
const EU_CLOUD = /https:\/\/(eu|eu-assets)(\.i)?\.posthog\.com/i;
const TRAILING_SLASH = /\/$/;

/** Where events go: `VITE_POSTHOG_HOST` as set, or EU Cloud when unset. */
export const posthogApiHost = (configured: string | undefined) =>
  configured ?? 'https://eu.i.posthog.com';

/** Where posthog-js 1.x loads its scripts from for `apiHost`, as its request
 * router decides: PostHog Cloud's regional assets host, or the host itself
 * for a proxy (empty: the page's own origin). */
export function posthogScriptHost(apiHost: string): string {
  const host = apiHost.trim().replace(TRAILING_SLASH, '');
  const region = US_CLOUD.test(host)
    ? 'us'
    : EU_CLOUD.test(host)
      ? 'eu'
      : undefined;
  return region ? `https://${region}-assets.i.posthog.com` : host;
}
