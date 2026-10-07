/**
 * Browser error reporting (Sentry) for the app. Product analytics lives apart
 * in analytics.ts: Sentry answers "what broke", is loaded eagerly, and must
 * survive an ad blocker taking out analytics; PostHog answers "what did people
 * do". Public pages (summary, /share/*) load analytics only, never Sentry.
 */

import * as Sentry from '@sentry/react';
import { isApiError } from '@/api/client';
import { identifyAnalytics, identityKey } from '@/lib/analytics';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const APP_ENV =
  (import.meta.env.VITE_APP_ENV as string | undefined) ?? 'development';
const RELEASE = import.meta.env.VITE_RELEASE_SHA as string | undefined;

export function initErrorReporting(): void {
  if (!SENTRY_DSN) return;
  Sentry.init({
    beforeSend: (event, hint) =>
      isApiError(hint.originalException) ? null : event,
    dsn: SENTRY_DSN,
    environment: APP_ENV,
    // Network failures during a stream are expected when a user navigates away
    // mid-answer, and would otherwise dominate the error volume.
    ignoreErrors: ['AbortError', 'Failed to fetch', 'NetworkError'],
    integrations: [
      Sentry.replayIntegration({ blockAllMedia: true, maskAllText: true }),
    ],
    release: RELEASE,
    replaysOnErrorSampleRate: 0.1,
    // Replays are only captured for sessions that errored. Notes and chat are
    // private content, so recording everyone by default is not acceptable.
    replaysSessionSampleRate: 0,
    // Sampled rather than off: performance data is useful, but this app opens
    // long-lived SSE and WebSocket connections that would otherwise generate a
    // transaction per keystroke-driven save.
    tracesSampleRate: 0.1,
  });
}

// React 19 routes caught render errors here, including our own boundaries.
export const reportReactError = Sentry.reactErrorHandler(
  import.meta.env.DEV
    ? (error, errorInfo) => {
        console.error('React error', error, errorInfo.componentStack);
      }
    : undefined
);

let lastIdentityKey: string | undefined;

export function identifyUser(userId: string | null, email?: string): void {
  const key = identityKey(userId, email);
  if (lastIdentityKey === key) return;
  lastIdentityKey = key;
  if (SENTRY_DSN) Sentry.setUser(userId ? { id: userId } : null);
  identifyAnalytics(userId, email);
}
