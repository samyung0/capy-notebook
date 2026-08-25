/**
 * Browser error reporting and product analytics.
 *
 * The two are kept apart deliberately. Sentry answers "what broke", is loaded
 * eagerly, and must survive an ad blocker taking out analytics. PostHog answers
 * "what did people do", is loaded lazily, and is allowed to fail silently —
 * a meaningful share of users block it, which is precisely why it is never
 * allowed to be the source of truth for anything a user is charged for. That
 * lives in `usage_events` in Postgres.
 */

import * as Sentry from '@sentry/react';
import {
  cloneSourceFromPath,
  identityKey,
  pageviewPath,
  quotaBlockedProps,
} from '@/lib/analytics';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
  'https://eu.i.posthog.com';
const APP_ENV =
  (import.meta.env.VITE_APP_ENV as string | undefined) ?? 'development';
const RELEASE = import.meta.env.VITE_RELEASE_SHA as string | undefined;

export function initErrorReporting(): void {
  if (!SENTRY_DSN) return;
  Sentry.init({
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

let lastIdentityKey: string | undefined;
let lastPageviewPath: string | undefined;

export function identifyUser(userId: string | null, email?: string): void {
  const key = identityKey(userId, email);
  if (lastIdentityKey === key) return;
  lastIdentityKey = key;

  if (SENTRY_DSN) {
    Sentry.setUser(userId ? { id: userId } : null);
  }
  if (!userId) {
    void posthog().then((client) => client?.reset());
    return;
  }
  void posthog().then((client) =>
    client?.identify(userId, email ? { email } : undefined)
  );
}

/* ------------------------------------------------------------- analytics */

type PostHog = typeof import('posthog-js').default;

let posthogPromise: Promise<PostHog | null> | null = null;

/**
 * Loads PostHog on first use. Lazy because it is ~60kB that nothing on the
 * critical path needs, and because a blocked request should cost nothing.
 */
function posthog(): Promise<PostHog | null> {
  if (!POSTHOG_KEY) return Promise.resolve(null);
  posthogPromise ??= import('posthog-js')
    .then(({ default: client }) => {
      client.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        // Events are named explicitly below; autocapture produces a stream of
        // untyped click events that nobody can build a funnel from.
        autocapture: false,
        capture_pageleave: true,
        capture_pageview: false,
        mask_all_element_attributes: true,
        // Note content and chat prompts must never leave in an analytics
        // payload.
        mask_all_text: true,
        persistence: 'localStorage',
      });
      return client;
    })
    .catch(() => null);
  return posthogPromise;
}

/**
 * The analytics event taxonomy.
 *
 * A closed union rather than free-form strings: the failure mode of product
 * analytics is twelve spellings of the same event across eighteen months, at
 * which point no funnel can be built retroactively. Names are
 * `object_verb_past_tense`, and properties are flat and low cardinality so they
 * are usable as breakdowns.
 *
 * Never put an id that identifies content here — workspace and material ids are
 * fine, titles and prompts are not.
 */
export type AnalyticsEvent =
  | { name: 'workspace_created'; props: { source: 'sidebar' | 'onboarding' } }
  | {
      name: 'source_uploaded';
      props: { kind: string; parseMode: string; sizeBucket: string };
    }
  | {
      name: 'source_ingest_completed';
      props: { kind: string; durationBucket: string; indexed: boolean };
    }
  | {
      name: 'chat_turn_sent';
      props: { workspaceId: string; hasScope: boolean };
    }
  | {
      name: 'chat_turn_completed';
      props: { workspaceId: string; status: string; citations: number };
    }
  | { name: 'material_generated'; props: { kind: string; workspaceId: string } }
  | {
      name: 'material_generate_failed';
      props: { kind: string; reason: string };
    }
  | { name: 'editor_ai_used'; props: { mode: 'command' | 'continue' } }
  | { name: 'quiz_attempt_finished'; props: { scoreBucket: string } }
  | { name: 'share_link_created'; props: { visibility: string } }
  | { name: 'collaborator_invited'; props: { role: string } }
  | { name: 'quota_blocked'; props: { code: string; surface: string } }
  | { name: 'subscription_checkout_started'; props: { tier: string } }
  | { name: 'note_created'; props: { workspaceId: string } }
  | {
      name: 'deck_study_finished';
      props: { cardCountBucket: string; source: 'app' | 'share' };
    }
  | {
      name: 'item_cloned';
      props: {
        kind: 'workspace' | 'quiz' | 'deck';
        source: 'share' | 'explore' | 'app';
      };
    }
  | { name: 'invite_accepted'; props: { role: string } }
  | {
      name: 'source_ingest_failed';
      props: { kind: string; stage: string; reason: string };
    };

const _analyticsEventNames: Record<AnalyticsEvent['name'], true> = {
  chat_turn_completed: true,
  chat_turn_sent: true,
  collaborator_invited: true,
  deck_study_finished: true,
  editor_ai_used: true,
  invite_accepted: true,
  item_cloned: true,
  material_generate_failed: true,
  material_generated: true,
  note_created: true,
  quiz_attempt_finished: true,
  quota_blocked: true,
  share_link_created: true,
  source_ingest_completed: true,
  source_ingest_failed: true,
  source_uploaded: true,
  subscription_checkout_started: true,
  workspace_created: true,
};
void _analyticsEventNames;

export function track<E extends AnalyticsEvent>(
  name: E['name'],
  props: E['props']
): void {
  void posthog().then((client) => client?.capture(name, props));
}

export function trackPageView(path: string): void {
  const next = pageviewPath(path);
  if (lastPageviewPath === next) return;
  lastPageviewPath = next;
  void posthog().then((client) =>
    client?.capture('$pageview', { $current_url: next })
  );
}

export function trackQuotaBlocked(error: unknown, surface: string): void {
  const props = quotaBlockedProps(error, surface);
  if (!props) return;
  track('quota_blocked', props);
}

export function trackItemCloned(
  kind: 'workspace' | 'quiz' | 'deck',
  pathname = typeof window === 'undefined' ? '' : window.location.pathname
): void {
  const source = cloneSourceFromPath(pathname);
  if (!source) return;
  track('item_cloned', { kind, source });
}

/**
 * Feature flags. Returns the fallback until PostHog has loaded, so a flag must
 * never gate something that would flicker or lose work if it flipped mid-session.
 */
export function featureEnabled(flag: string, fallback = false): boolean {
  if (!POSTHOG_KEY) return fallback;
  const client = posthogLoaded;
  if (!client) {
    void posthog().then((loaded) => {
      posthogLoaded = loaded;
    });
    return fallback;
  }
  return client.isFeatureEnabled(flag) ?? fallback;
}

let posthogLoaded: PostHog | null = null;
