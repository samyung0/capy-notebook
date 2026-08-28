import { isApiError } from '@/api/client';
import type { SourceImportAcceptedResponse } from '@/api/types';

export class SourceImportFailedError extends Error {
  readonly code: string;
  readonly fileName?: string;

  constructor(code: string, fileName?: string) {
    super('Source import failed');
    this.code = code;
    this.fileName = fileName;
    this.name = 'SourceImportFailedError';
  }
}

export class SourceImportPollingTimeoutError extends Error {
  constructor() {
    super('Source import is still processing in the background');
    this.name = 'SourceImportPollingTimeoutError';
  }
}

type ReadSourceImport = (
  jobId: string,
  signal?: AbortSignal
) => Promise<unknown>;

type SourceImportJob = SourceImportAcceptedResponse['jobs'][number];

type ParsedSourceImportStatus =
  | {
      jobId: string;
      name: string;
      status: 'pending' | 'running';
    }
  | {
      fileId?: string;
      jobId: string;
      name: string;
      status: 'succeeded';
    }
  | {
      errorCode?: string;
      jobId: string;
      name: string;
      status: 'failed' | 'cancelled';
    };

interface WaitForSourceImportOptions {
  initialDelayMilliseconds?: number;
  maxDelayMilliseconds?: number;
  maxWaitMilliseconds?: number;
  random?: () => number;
  signal?: AbortSignal;
}

export interface SourceImportWaveFailure {
  error: unknown;
  job: SourceImportJob;
}

export interface SourceImportWaveResult {
  completedJobIds: string[];
  failures: SourceImportWaveFailure[];
  fileIds: string[];
}

export interface CollectedSourceImportResponses {
  jobs: SourceImportJob[];
  rejected: SourceImportAcceptedResponse['rejected'];
  requestErrors: unknown[];
}

const DEFAULT_INITIAL_POLL_MILLISECONDS = 750;
const DEFAULT_MAX_POLL_MILLISECONDS = 10_000;
const DEFAULT_MAX_WAIT_MILLISECONDS = 15 * 60 * 1000;
const MAX_IMPORT_REQUEST_RETRIES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Record<string, unknown>,
  key: 'jobId' | 'name'
): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) {
    throw new SourceImportFailedError('invalid_import_response');
  }
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: 'errorCode' | 'fileId'
): string | undefined {
  const field = value[key];
  if (field === undefined) return;
  if (typeof field !== 'string' || !field.trim()) {
    throw new SourceImportFailedError('invalid_import_response');
  }
  return field;
}

export function parseSourceImportAcceptedResponse(
  value: unknown,
  expectedFileId?: string
): SourceImportAcceptedResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    !Array.isArray(value.rejected)
  ) {
    throw new SourceImportFailedError('invalid_import_response');
  }
  const jobs = value.jobs.map((item) => {
    if (!isRecord(item)) {
      throw new SourceImportFailedError('invalid_import_response');
    }
    const jobId = requiredString(item, 'jobId');
    const name = requiredString(item, 'name');
    const uploadId = item.uploadId;
    if (typeof uploadId !== 'string' || !uploadId.trim()) {
      throw new SourceImportFailedError('invalid_import_response');
    }
    return { jobId, name, uploadId };
  });
  const rejected = value.rejected.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.code !== 'string' ||
      !item.code.trim() ||
      typeof item.fileId !== 'string' ||
      !item.fileId.trim()
    ) {
      throw new SourceImportFailedError('invalid_import_response');
    }
    return { code: item.code, fileId: item.fileId };
  });
  if (jobs.length + rejected.length !== 1) {
    throw new SourceImportFailedError('invalid_import_response');
  }
  if (
    expectedFileId &&
    rejected.length === 1 &&
    rejected[0]?.fileId !== expectedFileId
  ) {
    throw new SourceImportFailedError('invalid_import_response');
  }
  return { jobs, rejected };
}

function parseSourceImportStatus(value: unknown): ParsedSourceImportStatus {
  if (!isRecord(value)) {
    throw new SourceImportFailedError('invalid_import_response');
  }
  const jobId = requiredString(value, 'jobId');
  const name = requiredString(value, 'name');
  const errorCode = optionalString(value, 'errorCode');
  const fileId = optionalString(value, 'fileId');
  switch (value.status) {
    case 'pending':
    case 'running':
      return { jobId, name, status: value.status };
    case 'succeeded':
      return {
        fileId,
        jobId,
        name,
        status: value.status,
      };
    case 'failed':
    case 'cancelled':
      return {
        errorCode,
        jobId,
        name,
        status: value.status,
      };
    default:
      throw new SourceImportFailedError('unknown_import_status', name);
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Import cancelled', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Import cancelled', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function importCancelledError() {
  return new DOMException('Import cancelled', 'AbortError');
}

function pollDelayMilliseconds(
  attempt: number,
  initialMilliseconds: number,
  maxMilliseconds: number,
  random: () => number
) {
  const exponential = Math.min(
    maxMilliseconds,
    initialMilliseconds * 2 ** attempt
  );
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.25;
  return Math.min(maxMilliseconds, Math.round(exponential * jitter));
}

export function collectSourceImportResponses(
  results: readonly PromiseSettledResult<unknown>[]
): CollectedSourceImportResponses {
  const collected: CollectedSourceImportResponses = {
    jobs: [],
    rejected: [],
    requestErrors: [],
  };
  for (const result of results) {
    if (result.status === 'rejected') {
      collected.requestErrors.push(result.reason);
      continue;
    }
    try {
      const response = parseSourceImportAcceptedResponse(result.value);
      collected.jobs.push(...response.jobs);
      collected.rejected.push(...response.rejected);
    } catch (error) {
      collected.requestErrors.push(error);
    }
  }
  return collected;
}

function sourceImportRequestRetryDelay(
  error: unknown,
  attempt: number
): number | null {
  if (attempt >= MAX_IMPORT_REQUEST_RETRIES) return null;
  if (error instanceof TypeError) {
    return Math.min(10_000, 1000 * 2 ** attempt);
  }
  if (
    !isApiError(error) ||
    (error.status !== 408 && error.status !== 429 && error.status < 500)
  ) {
    return null;
  }
  const retryAfter = Number(error.body?.retryAfterSeconds);
  if (error.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(30_000, Math.ceil(retryAfter) * 1000);
  }
  return Math.min(10_000, 1000 * 2 ** attempt);
}

export async function withSourceImportRequestRetry<T>(
  request: () => Promise<T>,
  wait?: (milliseconds: number) => Promise<void>,
  signal?: AbortSignal
): Promise<T> {
  const waitForRetry =
    wait ?? ((milliseconds: number) => abortableDelay(milliseconds, signal));
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) {
      throw importCancelledError();
    }
    try {
      return await request();
    } catch (error) {
      if (signal?.aborted) {
        throw importCancelledError();
      }
      const delay = sourceImportRequestRetryDelay(error, attempt);
      if (delay == null) throw error;
      await waitForRetry(delay);
    }
  }
}

export async function waitForSourceImport(
  read: ReadSourceImport,
  jobId: string,
  {
    initialDelayMilliseconds = DEFAULT_INITIAL_POLL_MILLISECONDS,
    maxDelayMilliseconds = DEFAULT_MAX_POLL_MILLISECONDS,
    maxWaitMilliseconds = DEFAULT_MAX_WAIT_MILLISECONDS,
    random = Math.random,
    signal,
  }: WaitForSourceImportOptions = {}
) {
  const deadline = Date.now() + maxWaitMilliseconds;
  let pollAttempt = 0;
  for (;;) {
    if (signal?.aborted) {
      throw new DOMException('Import cancelled', 'AbortError');
    }
    if (pollAttempt > 0 && Date.now() >= deadline) {
      throw new SourceImportPollingTimeoutError();
    }
    const job = parseSourceImportStatus(await read(jobId, signal));
    if (job.jobId !== jobId) {
      throw new SourceImportFailedError('invalid_import_response', job.name);
    }
    switch (job.status) {
      case 'succeeded':
        if (job.fileId) return job.fileId;
        throw new SourceImportFailedError('import_result_missing', job.name);
      case 'failed':
        throw new SourceImportFailedError(
          job.errorCode ?? 'source_import_failed',
          job.name
        );
      case 'cancelled':
        throw new SourceImportFailedError(
          job.errorCode ?? 'source_import_cancelled',
          job.name
        );
      case 'pending':
      case 'running':
        break;
      default: {
        const exhaustive: never = job;
        return exhaustive;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SourceImportPollingTimeoutError();
    }
    const delayMilliseconds = pollDelayMilliseconds(
      pollAttempt,
      initialDelayMilliseconds,
      maxDelayMilliseconds,
      random
    );
    pollAttempt += 1;
    await abortableDelay(Math.min(delayMilliseconds, remaining), signal);
  }
}

export async function waitForSourceImportWave(
  read: ReadSourceImport,
  jobs: readonly SourceImportJob[],
  options: WaitForSourceImportOptions = {}
): Promise<SourceImportWaveResult> {
  const results = await Promise.allSettled(
    jobs.map((job) => waitForSourceImport(read, job.jobId, options))
  );
  const wave: SourceImportWaveResult = {
    completedJobIds: [],
    failures: [],
    fileIds: [],
  };
  results.forEach((result, index) => {
    const job = jobs[index];
    if (!job) return;
    if (result.status === 'fulfilled') {
      wave.completedJobIds.push(job.jobId);
      wave.fileIds.push(result.value);
      return;
    }
    wave.failures.push({ error: result.reason, job });
  });
  return wave;
}
