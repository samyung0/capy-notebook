import type { ServerResponse } from 'node:http';
import * as Sentry from '@sentry/node';
import { afterAll, expect, it, vi } from 'vitest';

const EVENT_ID = /^[a-f0-9]{32}$/;

const probe = vi.hoisted(() => {
  const previousDSN = process.env.SENTRY_DSN;
  process.env.SENTRY_DSN = 'https://test@example.invalid/1';
  return {
    events: [] as Array<{
      event_id?: string;
      request?: {
        data?: unknown;
        cookies?: unknown;
        headers?: Record<string, string>;
      };
    }>,
    previousDSN,
  };
});

vi.mock('@sentry/node', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@sentry/node')>();
  return {
    ...sdk,
    init: (options: Parameters<typeof sdk.init>[0]) =>
      sdk.init({
        ...options,
        transport: () => ({
          flush: () => Promise.resolve(true),
          send: (envelope) => {
            for (const [header, payload] of envelope[1]) {
              if (header.type === 'event')
                probe.events.push(
                  payload as {
                    event_id?: string;
                    request?: {
                      data?: unknown;
                      cookies?: unknown;
                      headers?: Record<string, string>;
                    };
                  }
                );
            }
            return Promise.resolve({ statusCode: 200 });
          },
        }),
      }),
  };
});

import { reportFailedStore } from './failedStoreRetry.js';
import {
  captureError,
  ERROR_EVENT_HEADER,
  initErrorReporting,
  RETRY_EVENT_HEADER,
  reportHttpError,
  retryEventHeaders,
  withEventId,
  withRetryEvent,
} from './observability.js';
import type { YjsDocumentStore } from './persistence.js';
import { ProjectionService } from './projection.js';

it('reports each causal failure once across catch, HTTP relay and projection cleanup', async () => {
  initErrorReporting();
  const failure = new Error('database failed');
  const id = Sentry.withScope((scope) => {
    scope.addEventProcessor((event) => ({
      ...event,
      request: {
        cookies: { session: 'secret' },
        data: 'private note',
        headers: { traceparent: 'safe', 'X-Collaboration-Secret': 'secret' },
      },
    }));
    return captureError(failure);
  });
  expect(id).toMatch(EVENT_ID);
  const response = {
    headersSent: false,
    setHeader: vi.fn(),
  } as unknown as ServerResponse;
  reportHttpError(response, failure);
  expect(response.setHeader).toHaveBeenCalledWith(ERROR_EVENT_HEADER, id);
  const wrapper = new Error('request failed', { cause: failure });
  expect(captureError(wrapper)).toBe(id);
  Sentry.captureException(wrapper);
  await Sentry.flush(1000);
  expect(probe.events).toHaveLength(1);
  expect(probe.events[0].request?.data).toBeUndefined();
  expect(probe.events[0].request?.cookies).toBeUndefined();
  expect(probe.events[0].request?.headers).toEqual({ traceparent: 'safe' });

  const upstreamId = 'a'.repeat(32);
  const upstream = withEventId(new Error('upstream failed'), upstreamId);
  expect(captureError(upstream)).toBe(upstreamId);
  const badId = withEventId(new Error('bad header'), 'not-an-event');
  captureError(badId);
  await Sentry.flush(1000);
  expect(probe.events).toHaveLength(2);

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response('failed', {
        headers: { [ERROR_EVENT_HEADER]: upstreamId },
        status: 500,
      })
    )
  );
  const store = {
    recordProjectionError: vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error('cleanup failed'))),
  } as unknown as YjsDocumentStore;
  const projection = new ProjectionService(
    store,
    'http://internal.invalid',
    'secret'
  );
  await expect(
    projection.projectAndRecord('material', 1, { schemaVersion: 1, value: [] })
  ).rejects.toThrow('projection failed');
  await Sentry.flush(1000);
  expect(probe.events).toHaveLength(3);
  const fetchRetry = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response('failed', {
        headers: { [ERROR_EVENT_HEADER]: upstreamId },
        status: 500,
      })
    )
  );
  vi.stubGlobal('fetch', fetchRetry);
  await projection
    .projectAndRecord('material', 2, { schemaVersion: 1, value: [] })
    .catch(() => undefined);
  await projection
    .projectAndRecord('material', 3, { schemaVersion: 1, value: [] })
    .catch(() => undefined);
  expect(fetchRetry.mock.calls[0][1].headers[RETRY_EVENT_HEADER]).toBe(
    upstreamId
  );
  await Sentry.flush(1000);
  expect(probe.events).toHaveLength(3);
  fetchRetry.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await projection.projectAndRecord('material', 4, {
    schemaVersion: 1,
    value: [],
  });
  fetchRetry.mockResolvedValueOnce(
    new Response('new failure', { status: 500 })
  );
  await projection
    .projectAndRecord('material', 5, { schemaVersion: 1, value: [] })
    .catch(() => undefined);
  expect(
    fetchRetry.mock.calls[3][1].headers[RETRY_EVENT_HEADER]
  ).toBeUndefined();
  await Sentry.flush(1000);
  expect(probe.events).toHaveLength(5);

  const saveId = reportFailedStore(undefined, new Error('save failed'), 'room');
  const failed = {
    checkpointIds: [],
    eventId: saveId,
    state: new Uint8Array(),
  };
  const retryFailure = new Error('retry failed');
  expect(reportFailedStore(failed, retryFailure, 'room')).toBe(saveId);
  reportHttpError(response, retryFailure);
  reportFailedStore(undefined, new Error('new failure after recovery'), 'room');
  await Sentry.flush(1000);
  expect(probe.events).toHaveLength(7);

  const retryHeaders = await Promise.all(
    ['a'.repeat(32), 'b'.repeat(32)].map((eventId) =>
      withRetryEvent(eventId, async () => {
        await Promise.resolve();
        return retryEventHeaders();
      })
    )
  );
  expect(retryHeaders.map((headers) => headers[RETRY_EVENT_HEADER])).toEqual([
    'a'.repeat(32),
    'b'.repeat(32),
  ]);
  expect(retryEventHeaders()).toEqual({});
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await Sentry.close(1000);
  if (probe.previousDSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = probe.previousDSN;
});
