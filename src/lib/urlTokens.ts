/**
 * Bearer tokens that ride in URLs open what they name, so logs and telemetry
 * keep their shape only (Sam 2026-10-19, 13a): a share link `{id}.{signature}`
 * keeps its id, and an invite link `/workspace-invites/{token}` loses its token.
 * PostHog (`sanitize_properties`) and Sentry (`beforeSend`, `beforeBreadcrumb`)
 * run every string through here; the gateway's access log hashes the same
 * segments (`obs.LogPath`).
 */

const SHARE_SIGNATURE =
  /([a-z]+_[A-Za-z0-9_-]{1,64})\.[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g;
const INVITE_TOKEN = /(workspace-invites(?:\/|%2F))[A-Za-z0-9_-]+/gi;

export function stripUrlTokens(text: string): string {
  return text.replace(SHARE_SIGNATURE, '$1').replace(INVITE_TOKEN, '$1:token');
}

/** stripUrlTokens over every string inside value, in place where it can. */
export function stripUrlTokensDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return stripUrlTokens(value) as T;
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      value[i] = stripUrlTokensDeep(value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    record[key] = stripUrlTokensDeep(record[key], depth + 1);
  return value;
}

/** Replay's beforeAddRecordingEvent, which @sentry/replay calls for Custom
 * recording events only: the replay's breadcrumbs and performance spans
 * (navigation and fetch URLs). The Meta event's page href and the DOM frames
 * never reach it. */
export function scrubRecordingEvent<T extends { data?: unknown }>(event: T): T {
  stripUrlTokensDeep(event.data);
  return event;
}
