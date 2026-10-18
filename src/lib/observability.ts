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
const REPLAY_SESSIONS = 0.1;
const REPLAY_KEY = 'capy.replay';

/**
 * Whether this browser session records error replays: one in ten, decided at
 * its first page load and kept in sessionStorage (Epo 2026-10-18). Each keeps
 * a replay for every error, the same expected number as every session
 * buffering at 0.1, and the others never load rrweb. Without sessionStorage
 * none does.
 */
export function replaySampled(): boolean {
  try {
    let sampled = sessionStorage.getItem(REPLAY_KEY);
    if (sampled === null) {
      sampled = Math.random() < REPLAY_SESSIONS ? '1' : '0';
      sessionStorage.setItem(REPLAY_KEY, sampled);
    }
    return sampled === '1';
  } catch {
    return false;
  }
}

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
    release: RELEASE,
    // Replays are only captured for sessions that errored, and only in the
    // sampled ones, which add the integration below. Notes and chat are
    // private content, so recording everyone by default is not acceptable.
    replaysOnErrorSampleRate: 1,
    replaysSessionSampleRate: 0,
    // Sampled rather than off: performance data is useful, but this app opens
    // long-lived SSE and WebSocket connections that would otherwise generate a
    // transaction per keystroke-driven save.
    tracesSampleRate: 0.1,
  });
  if (replaySampled())
    void import('./sentryReplay').then(({ replayIntegration }) =>
      Sentry.addIntegration(
        replayIntegration({ blockAllMedia: true, maskAllText: true })
      )
    );
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
