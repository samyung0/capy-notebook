/**
 * Thin fetch wrapper around the API. One base URL so the real
 * backend can be dropped in later by changing `API_BASE`.
 */
import { authHeaders } from './auth';

export const API_BASE = '/api';

export interface ApiErrorBody {
  code?: string;
  detail?: string;
  message?: string;
  [key: string]: unknown;
}

/** Typed HTTP failure so callers can branch on status (404 private, 401, …). */
export class ApiError extends Error {
  readonly body: ApiErrorBody | null;
  readonly code: string | null;
  readonly status: number;
  readonly statusText: string;

  constructor(
    status: number,
    statusText: string,
    detail?: string,
    body: ApiErrorBody | null = null
  ) {
    super(`${status} ${statusText}${detail ? ` — ${detail}` : ''}`);
    this.name = 'ApiError';
    this.body = body;
    this.code = body?.code ?? null;
    this.status = status;
    this.statusText = statusText;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isStorageQuotaError(err: unknown): err is ApiError {
  return isApiError(err) && err.code === 'storage_quota_exceeded';
}

export function isCreditsExhaustedError(err: unknown): err is ApiError {
  return isApiError(err) && err.code === 'llm_credits_exhausted';
}

export function isTooManyIngestLeasesError(err: unknown): err is ApiError {
  return isApiError(err) && err.code === 'too_many_ingest_leases';
}

export function isFileLimitError(err: unknown): err is ApiError {
  return (
    isApiError(err) &&
    (err.code === 'files_limit_exceeded' || err.code === 'files_batch_exceeded')
  );
}

export function isModelUnavailableError(err: unknown): err is ApiError {
  return isApiError(err) && err.code === 'model_unavailable';
}

export function isInvalidLLMKeyError(err: unknown): err is ApiError {
  return isApiError(err) && err.code === 'invalid_llm_key';
}

export function isLLMKeyFailedError(err: unknown): err is ApiError {
  return isApiError(err) && err.code === 'llm_key_failed';
}

export function isLLMKeyError(err: unknown): err is ApiError {
  return isInvalidLLMKeyError(err) || isLLMKeyFailedError(err);
}

/** The stored document exists but the server could not decode it. Distinct from
 * a missing material, which the UI reports as deleted. */
export function isMaterialContentUnreadable(err: unknown): err is ApiError {
  return isApiError(err) && err.code === 'material_content_unreadable';
}

const ACCOUNT_FORBIDDEN_CODES = new Set([
  'account_deleted',
  'account_suspended',
  'account_deletion_pending',
  'account_over_quota',
  'account_locked',
]);

const CODED_ERROR_MESSAGES = new Set([
  'storage_quota_exceeded',
  'files_limit_exceeded',
  'files_batch_exceeded',
  'llm_credits_exhausted',
  'model_unavailable',
  'invalid_llm_key',
  'llm_key_failed',
  'material_content_unreadable',
  ...ACCOUNT_FORBIDDEN_CODES,
]);

/** Auth middleware / write gates refuse the session or mutation. */
export function isAccountForbiddenError(err: unknown): err is ApiError {
  return (
    isApiError(err) &&
    err.status === 403 &&
    !!err.code &&
    ACCOUNT_FORBIDDEN_CODES.has(err.code)
  );
}

export function isAccountBlockingError(err: unknown): err is ApiError {
  return (
    isApiError(err) &&
    err.status === 403 &&
    (err.code === 'account_suspended' ||
      err.code === 'account_deleted' ||
      err.code === 'account_deletion_pending')
  );
}

function parseErrorBody(value: unknown): ApiErrorBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as ApiErrorBody & {
    errors?: Array<{ message?: string; value?: unknown }>;
  };
  // Huma packs machine codes in errors[].message (quota + account locks).
  const coded = body.errors?.find(
    (error) =>
      typeof error.message === 'string' &&
      CODED_ERROR_MESSAGES.has(error.message)
  );
  if (!coded?.message) return body;
  const details =
    typeof coded.value === 'object' && coded.value !== null ? coded.value : {};
  return { ...body, ...details, code: coded.message };
}

function errorDetail(body: ApiErrorBody | null) {
  return body?.message ?? body?.detail;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...auth,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = parseErrorBody(await res.json());
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, res.statusText, errorDetail(body), body);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

/** Multipart upload (real file bytes). XHR is used so callers can report
 * byte-level progress and cancel an in-flight request. */
async function upload<T>(
  path: string,
  form: FormData,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<T> {
  const auth = await authHeaders();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const succeed = (value: T) => {
      cleanup();
      onProgress?.(100);
      resolve(value);
    };

    xhr.open('POST', `${API_BASE}${path}`);
    for (const [name, value] of Object.entries(auth))
      xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let body: ApiErrorBody | null = null;
        try {
          body = parseErrorBody(JSON.parse(xhr.responseText));
        } catch {
          /* ignore */
        }
        fail(new ApiError(xhr.status, xhr.statusText, errorDetail(body), body));
        return;
      }
      if (xhr.status === 204 || !xhr.responseText) {
        succeed(undefined as T);
        return;
      }
      try {
        succeed(JSON.parse(xhr.responseText) as T);
      } catch (error) {
        fail(
          error instanceof Error ? error : new Error('Invalid JSON response')
        );
      }
    };
    xhr.onerror = () => fail(new Error('Upload failed: network error'));
    xhr.onabort = () =>
      fail(new DOMException('Upload cancelled', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        fail(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }
    xhr.send(form);
  });
}

/** Upload bytes to a storage-provider URL without adding API auth headers.
 * XHR is used because fetch still has no upload-progress events. */
function putFile(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const succeed = () => {
      cleanup();
      onProgress?.(100);
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers))
      xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) succeed();
      else fail(new Error(`B2 upload failed: ${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => fail(new Error('B2 upload failed: network error'));
    xhr.onabort = () =>
      fail(new DOMException('Upload cancelled', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        fail(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }
    xhr.send(file);
  });
}

type RequestOptions = Pick<RequestInit, 'signal'>;

export const api = {
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      body: body === undefined ? undefined : JSON.stringify(body),
      method: 'PATCH',
    }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      body: body === undefined ? undefined : JSON.stringify(body),
      method: 'POST',
    }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      body: body === undefined ? undefined : JSON.stringify(body),
      method: 'PUT',
    }),
  putFile,
  upload: <T>(
    path: string,
    form: FormData,
    onProgress?: (pct: number) => void,
    signal?: AbortSignal
  ) => upload<T>(path, form, onProgress, signal),
};

/** Central query-key registry for TanStack Query. */
export const qk = {
  accountStatus: ['account', 'status'] as const,
  attempt: (id: string) => ['attempt', id] as const,
  attempts: ['attempts'] as const,
  billing: ['billing'] as const,
  canvas: (id: string) => ['canvas', id] as const,
  cards: (deckId: string) => ['deck', deckId, 'cards'] as const,
  chapters: (wsId: string) => ['workspace', wsId, 'chapters'] as const,
  conversations: (wsId: string) =>
    ['workspace', wsId, 'conversations'] as const,
  deck: (id: string) => ['deck', id] as const,
  decks: ['decks'] as const,
  deletionPreflight: ['account', 'deletion'] as const,
  events: ['events'] as const,
  exploreDecks: ['explore', 'decks'] as const,
  exploreQuizzes: ['explore', 'quizzes'] as const,
  exploreWorkspaces: ['explore', 'workspaces'] as const,
  file: (id: string) => ['file', id] as const,
  files: (wsId: string) => ['workspace', wsId, 'files'] as const,
  ingestSlots: ['me', 'ingest-slots'] as const,
  ingestStream: (wsId: string) => ['workspace', wsId, 'ingest-stream'] as const,
  integrations: ['integrations'] as const,
  labels: ['labels'] as const,
  llmCredentials: ['llm-credentials'] as const,
  material: (id: string) => ['material', id] as const,
  materialDiscussions: (id: string) => ['material', id, 'discussions'] as const,
  materialRevisions: (id: string) => ['material', id, 'revisions'] as const,
  materials: (wsId: string) => ['workspace', wsId, 'materials'] as const,
  me: ['me'] as const,
  messages: (convId: string) => ['conversation', convId, 'messages'] as const,
  mistakes: ['mistakes'] as const,
  models: (surface: string) => ['models', surface] as const,
  notificationPrefs: ['notification-prefs'] as const,
  notificationStream: ['notifications', 'stream'] as const,
  notifications: ['notifications'] as const,
  notificationUnread: ['notifications', 'unread-count'] as const,
  quiz: (id: string) => ['quiz', id] as const,
  quizzes: ['quizzes'] as const,
  search: (q: string) => ['search', q] as const,
  sourceUploadPolicy: (wsId?: string) =>
    ['source-upload-policy', wsId ?? null] as const,
  tags: (kind: string) => ['tags', kind] as const,
  tasks: ['tasks'] as const,
  thinking: ['thinking'] as const,
  usage: ['usage'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  workspaceCollaborators: (id: string) =>
    ['workspace', id, 'collaborators'] as const,
  workspaceMembers: (id: string) => ['workspace', id, 'members'] as const,
  workspaceStats: (id: string) => ['workspace', id, 'stats'] as const,
  workspaces: (params?: unknown) => ['workspaces', params ?? null] as const,
};
