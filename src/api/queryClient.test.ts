import { expect, it } from 'vitest';
import { ApiError } from './client';
import { queryClient } from './queryClient';

// security regression: rate-limit audit L12
it('leaves a rate-limited read to the user instead of retrying it', () => {
  const retry = queryClient.getDefaultOptions().queries?.retry as (
    failureCount: number,
    error: unknown
  ) => boolean;
  expect(retry(0, new ApiError(429, 'Too Many Requests'))).toBe(false);
  expect(retry(0, new ApiError(503, 'Service Unavailable'))).toBe(true);
});
