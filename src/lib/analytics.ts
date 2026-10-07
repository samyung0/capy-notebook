import { isApiError } from '@/api/client';
import { errorKind } from '@/lib/errors';

/* Product analytics (PostHog), loaded lazily and allowed to fail silently: a
   meaningful share of users block it, which is why it is never the source of
   truth for anything a user is charged for (that lives in `usage_events`).
   Public pages use it without the app's error reporting (observability.ts). */

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
  'https://eu.i.posthog.com';
const MIB = 1024 * 1024;

export type SizeBucket =
  | 'lt1mb'
  | '1to10mb'
  | '10to50mb'
  | '50to100mb'
  | 'gte100mb';
export type DurationBucket = 'lt10s' | '10to60s' | '1to5m' | 'gte5m';
export type ScoreBucket = 'lt50' | '50to69' | '70to89' | 'gte90';
export type CardCountBucket = '1' | '2to10' | '11to30' | '31to100' | 'gt100';
export type CloneSource = 'share' | 'explore' | 'app';

export function sizeBucket(bytes: number): SizeBucket {
  if (bytes < MIB) return 'lt1mb';
  if (bytes < 10 * MIB) return '1to10mb';
  if (bytes < 50 * MIB) return '10to50mb';
  if (bytes < 100 * MIB) return '50to100mb';
  return 'gte100mb';
}

export function durationBucket(ms: number): DurationBucket {
  if (ms < 10_000) return 'lt10s';
  if (ms < 60_000) return '10to60s';
  if (ms < 5 * 60_000) return '1to5m';
  return 'gte5m';
}

/** `pct` is awarded/max on a 0–100 scale. */
export function scoreBucket(pct: number): ScoreBucket {
  if (pct < 50) return 'lt50';
  if (pct < 70) return '50to69';
  if (pct < 90) return '70to89';
  return 'gte90';
}

export function cardCountBucket(count: number): CardCountBucket {
  if (count <= 1) return '1';
  if (count <= 10) return '2to10';
  if (count <= 30) return '11to30';
  if (count <= 100) return '31to100';
  return 'gt100';
}

const SEARCH_OR_HASH = /[?#]/;

export function pageviewPath(routePattern: string): string {
  const path = routePattern.split(SEARCH_OR_HASH, 1)[0] || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export function cloneSourceFromPath(pathname: string): CloneSource | null {
  if (pathname.includes('/share/')) return 'share';
  if (pathname === '/explore' || pathname.startsWith('/explore/')) {
    return 'explore';
  }
  if (
    ['/files', '/learning', '/materials', '/quizzes', '/flashcards'].some(
      (root) => pathname === root || pathname.startsWith(`${root}/`)
    )
  ) {
    return 'app';
  }
  return null;
}

export function flashcardsStudySource(pathname: string): 'app' | 'share' {
  return pathname.includes('/share/flashcards') ? 'share' : 'app';
}

const STAGE_CODE = /^[a-z][a-z0-9_]{0,40}$/;

export function ingestStageCode(stage: unknown): string {
  return typeof stage === 'string' && STAGE_CODE.test(stage)
    ? stage
    : 'unknown';
}

/** Low-cardinality fail reason. Never the SSE `message` (filenames, dumps). */
export function ingestFailReason(stage: unknown): string {
  const code = ingestStageCode(stage);
  return code === 'unknown' ? 'failed' : code;
}

export function failureReason(error: unknown): string {
  if (isApiError(error) && error.code) return error.code;
  return errorKind(error);
}

export function quotaBlockedProps(
  error: unknown,
  surface: string
): { code: string; surface: string } | null {
  const kind = errorKind(error);
  if (kind !== 'quota' && kind !== 'credits') return null;
  const code = isApiError(error) && error.code ? error.code : kind;
  return { code, surface };
}

export function identityKey(userId: string | null, email?: string): string {
  if (!userId) return '';
  return `${userId}\0${email ?? ''}`;
}

export function createIngestTracker() {
  const startedAt = new Map<string, number>();
  const fired = new Set<string>();

  return {
    markStart(fileId: string, now = Date.now()): void {
      if (!startedAt.has(fileId)) startedAt.set(fileId, now);
    },
    reset(): void {
      startedAt.clear();
      fired.clear();
    },
    takeTerminal(
      fileId: string,
      status: 'ready' | 'failed',
      now = Date.now()
    ): { durationMs: number } | null {
      const key = `${fileId}:${status}`;
      if (fired.has(key)) return null;
      fired.add(key);
      const start = startedAt.get(fileId) ?? now;
      return { durationMs: Math.max(0, now - start) };
    },
  };
}

export const ingestTracker = createIngestTracker();

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
  | { name: 'summary_viewed'; props: { workspaceId: string } }
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
      name: 'flashcards_study_finished';
      props: { cardCountBucket: string; source: 'app' | 'share' };
    }
  | {
      name: 'item_cloned';
      props: {
        kind: 'workspace' | 'quiz' | 'flashcards' | 'material';
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
  editor_ai_used: true,
  flashcards_study_finished: true,
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
  summary_viewed: true,
  workspace_created: true,
};
void _analyticsEventNames;

export function track<E extends AnalyticsEvent>(
  name: E['name'],
  props: E['props']
): void {
  void posthog().then((client) => client?.capture(name, props));
}

/** Ties later events to the signed-in user, or forgets them on sign-out. */
export function identifyAnalytics(userId: string | null, email?: string) {
  if (!userId) {
    void posthog().then((client) => client?.reset());
    return;
  }
  void posthog().then((client) =>
    client?.identify(userId, email ? { email } : undefined)
  );
}

let lastPageviewPath: string | undefined;

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
  kind: 'workspace' | 'quiz' | 'flashcards' | 'material',
  pathname = typeof window === 'undefined' ? '' : window.location.pathname
): void {
  const source = cloneSourceFromPath(pathname);
  if (!source) return;
  track('item_cloned', { kind, source });
}
