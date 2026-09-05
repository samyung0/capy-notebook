import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import type { AnalyticsEvent } from '@/lib/observability';
import {
  cardCountBucket,
  cloneSourceFromPath,
  createIngestTracker,
  durationBucket,
  failureReason,
  flashcardsStudySource,
  identityKey,
  ingestFailReason,
  ingestStageCode,
  pageviewPath,
  quotaBlockedProps,
  scoreBucket,
  sizeBucket,
} from './analytics';

const ANALYTICS_EVENT_NAMES = {
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
} as const satisfies Record<AnalyticsEvent['name'], true>;

describe('analytics helpers', () => {
  it('keeps the closed event union exhaustive', () => {
    expect(Object.keys(ANALYTICS_EVENT_NAMES)).toHaveLength(19);
  });

  it.each([
    [0, 'lt1mb'],
    [1024 * 1024 - 1, 'lt1mb'],
    [1024 * 1024, '1to10mb'],
    [10 * 1024 * 1024 - 1, '1to10mb'],
    [10 * 1024 * 1024, '10to50mb'],
    [50 * 1024 * 1024, '50to100mb'],
    [100 * 1024 * 1024, 'gte100mb'],
  ] as const)('sizeBucket(%s) is %s', (bytes, bucket) => {
    expect(sizeBucket(bytes)).toBe(bucket);
  });

  it.each([
    [0, 'lt10s'],
    [9999, 'lt10s'],
    [10_000, '10to60s'],
    [60_000, '1to5m'],
    [5 * 60_000, 'gte5m'],
  ] as const)('durationBucket(%s) is %s', (ms, bucket) => {
    expect(durationBucket(ms)).toBe(bucket);
  });

  it.each([
    [0, 'lt50'],
    [49, 'lt50'],
    [50, '50to69'],
    [70, '70to89'],
    [90, 'gte90'],
    [100, 'gte90'],
  ] as const)('scoreBucket(%s) is %s', (pct, bucket) => {
    expect(scoreBucket(pct)).toBe(bucket);
  });

  it.each([
    [1, '1'],
    [2, '2to10'],
    [11, '11to30'],
    [31, '31to100'],
    [101, 'gt100'],
  ] as const)('cardCountBucket(%s) is %s', (count, bucket) => {
    expect(cardCountBucket(count)).toBe(bucket);
  });

  it('uses the route pattern and drops search', () => {
    expect(pageviewPath('/workspaces/$workspaceId?tab=files')).toBe(
      '/workspaces/$workspaceId'
    );
    expect(pageviewPath('workspaces/$workspaceId')).toBe(
      '/workspaces/$workspaceId'
    );
  });

  it('classifies clone source from the path', () => {
    expect(cloneSourceFromPath('/share/workspaces/ws_1')).toBe('share');
    expect(cloneSourceFromPath('/explore')).toBe('explore');
    expect(cloneSourceFromPath('/quizzes')).toBe('app');
    expect(cloneSourceFromPath('/quizzes/q_1/attempt')).toBe('app');
    expect(cloneSourceFromPath('/flashcards')).toBe('app');
    expect(cloneSourceFromPath('/flashcards/d_1')).toBe('app');
    expect(cloneSourceFromPath('/workspaces/ws_1')).toBeNull();
  });

  it('labels flashcards study from the share path', () => {
    expect(flashcardsStudySource('/share/flashcards/d_1')).toBe('share');
    expect(flashcardsStudySource('/flashcards/d_1')).toBe('app');
  });

  it('keeps ingest stage and reason as short codes', () => {
    expect(ingestStageCode('parsing')).toBe('parsing');
    expect(ingestStageCode('ingest_job_pins')).toBe('ingest_job_pins');
    expect(ingestStageCode('notes/midterm.pdf: boom')).toBe('unknown');
    expect(ingestFailReason('parsing')).toBe('parsing');
    expect(ingestFailReason('???')).toBe('failed');
  });

  it('prefers an API code over a generic error kind', () => {
    expect(
      failureReason(
        new ApiError(403, 'Forbidden', undefined, {
          code: 'storage_quota_exceeded',
        })
      )
    ).toBe('storage_quota_exceeded');
    expect(failureReason(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('emits quota props only for quota and credits', () => {
    expect(
      quotaBlockedProps(
        new ApiError(403, 'Forbidden', undefined, {
          code: 'storage_quota_exceeded',
        }),
        'upload'
      )
    ).toEqual({ code: 'storage_quota_exceeded', surface: 'upload' });
    expect(
      quotaBlockedProps(
        new ApiError(402, 'Payment Required', undefined, {
          code: 'llm_credits_exhausted',
        }),
        'mutation'
      )
    ).toEqual({ code: 'llm_credits_exhausted', surface: 'mutation' });
    expect(
      quotaBlockedProps(new ApiError(401, 'Unauthorized'), 'mutation')
    ).toBeNull();
  });

  it('keys identify by user id and email', () => {
    expect(identityKey('u_1', 'kate@capynotebook.app')).toBe(
      identityKey('u_1', 'kate@capynotebook.app')
    );
    expect(identityKey('u_1', 'kate@capynotebook.app')).not.toBe(
      identityKey('u_1')
    );
    expect(identityKey(null)).toBe('');
  });

  it('fires ingest terminals once per file and status', () => {
    const tracker = createIngestTracker();
    tracker.markStart('f1', 1000);
    const first = tracker.takeTerminal('f1', 'ready', 12_000);
    expect(first?.durationMs).toBe(11_000);
    expect(tracker.takeTerminal('f1', 'ready', 13_000)).toBeNull();
    expect(tracker.takeTerminal('f1', 'failed', 13_000)?.durationMs).toBe(
      12_000
    );
  });
});
