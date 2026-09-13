import * as Sentry from '@sentry/react';
import { afterAll, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';

const probe = vi.hoisted(() => {
  vi.stubEnv('VITE_SENTRY_DSN', 'https://test@example.invalid/1');
  return { events: [] as Array<{ event_id?: string }> };
});

vi.mock('@sentry/react', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@sentry/react')>();
  return {
    ...sdk,
    init: (options: Parameters<typeof sdk.init>[0]) =>
      sdk.init({
        ...options,
        integrations: [],
        transport: () => ({
          flush: () => Promise.resolve(true),
          send: (envelope) => {
            for (const [header, payload] of envelope[1]) {
              if (header.type === 'event')
                probe.events.push(payload as { event_id?: string });
            }
            return Promise.resolve({ statusCode: 200 });
          },
        }),
      }),
  };
});

import { initErrorReporting, reportReactError } from './observability';

it('reports caught React crashes once and leaves API failures with the server', async () => {
  initErrorReporting();
  const crash = new Error('render failed');
  reportReactError(crash, { componentStack: '\n at BrokenComponent' });
  Sentry.captureException(crash);
  reportReactError(new ApiError(500, 'Internal Server Error'), {
    componentStack: '\n at QueryPage',
  });
  await Sentry.flush(1000);
  expect(probe.events).toHaveLength(1);
});

afterAll(async () => {
  await Sentry.close(1000);
  vi.unstubAllEnvs();
});
