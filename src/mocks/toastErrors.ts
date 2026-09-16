import { ApiError } from '@/api/client';
import type { ErrorKind } from '@/lib/errors';

const coded = (status: number, code: string, extra?: Record<string, unknown>) =>
  new ApiError(status, 'Mock failure', undefined, { code, ...extra });

/** One representative error per toast-producing ErrorKind (cancelled never toasts). */
export const toastErrors: readonly {
  kind: ErrorKind;
  label: string;
  error: () => unknown;
}[] = [
  {
    error: () => new TypeError('Failed to fetch'),
    kind: 'offline',
    label: 'Offline',
  },
  {
    error: () => new TypeError('Failed to fetch'),
    kind: 'network',
    label: 'Network',
  },
  {
    error: () => new ApiError(401, 'Unauthorized'),
    kind: 'auth',
    label: 'Auth 401',
  },
  {
    error: () => new ApiError(403, 'Forbidden'),
    kind: 'forbidden',
    label: 'Forbidden 403',
  },
  {
    error: () => new ApiError(404, 'Not Found'),
    kind: 'notFound',
    label: 'Not found 404',
  },
  {
    error: () => coded(403, 'storage_quota_exceeded'),
    kind: 'quota',
    label: 'Storage quota',
  },
  {
    error: () => coded(403, 'account_over_quota'),
    kind: 'quota',
    label: 'Account over quota',
  },
  {
    error: () => coded(403, 'files_limit_exceeded', { filesLimit: 100 }),
    kind: 'files',
    label: 'File cap',
  },
  {
    error: () => coded(403, 'files_batch_exceeded', { filesLimit: 20 }),
    kind: 'files',
    label: 'File batch cap',
  },
  {
    error: () => coded(402, 'llm_credits_exhausted'),
    kind: 'credits',
    label: 'Credits exhausted',
  },
  {
    error: () => coded(429, 'too_many_ingest_leases'),
    kind: 'ingest',
    label: 'Ingest slots',
  },
  {
    error: () => coded(422, 'model_unavailable'),
    kind: 'model',
    label: 'Model unavailable',
  },
  {
    error: () => coded(503, 'provider_busy'),
    kind: 'busy',
    label: 'Provider busy',
  },
  {
    error: () => coded(422, 'invalid_llm_key'),
    kind: 'llmKey',
    label: 'LLM key invalid',
  },
  {
    error: () => coded(422, 'llm_key_failed'),
    kind: 'llmKey',
    label: 'LLM key failed',
  },
  {
    error: () => coded(409, 'source_changed'),
    kind: 'sourceChanged',
    label: 'Source changed',
  },
  {
    error: () => new ApiError(422, 'Unprocessable Entity'),
    kind: 'validation',
    label: 'Validation 422',
  },
  {
    error: () => new ApiError(500, 'Internal Server Error'),
    kind: 'server',
    label: 'Server 500',
  },
  {
    error: () =>
      new TypeError(
        'Failed to fetch dynamically imported module: /mock/chunk.js'
      ),
    kind: 'chunkLoad',
    label: 'Chunk load',
  },
  {
    error: () => new Error('Mock unknown error'),
    kind: 'unknown',
    label: 'Unknown',
  },
];
