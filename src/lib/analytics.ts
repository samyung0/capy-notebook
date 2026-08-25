import { isApiError } from '@/api/client';
import { errorKind } from '@/lib/errors';

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
    pathname === '/quizzes' ||
    pathname.startsWith('/quizzes/') ||
    pathname === '/flashcards' ||
    pathname.startsWith('/flashcards/')
  ) {
    return 'app';
  }
  return null;
}

export function deckStudySource(pathname: string): 'app' | 'share' {
  return pathname.includes('/share/decks') ? 'share' : 'app';
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
