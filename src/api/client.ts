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

function parseErrorBody(value: unknown): ApiErrorBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as ApiErrorBody & {
    errors?: Array<{ message?: string; value?: unknown }>;
  };
  const quotaError = body.errors?.find(
    (error) => error.message === 'storage_quota_exceeded'
  );
  const details =
    typeof quotaError?.value === 'object' && quotaError.value !== null
      ? quotaError.value
      : {};
  return quotaError
    ? { ...body, ...details, code: 'storage_quota_exceeded' }
    : body;
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
  events: ['events'] as const,
  exploreDecks: ['explore', 'decks'] as const,
  exploreQuizzes: ['explore', 'quizzes'] as const,
  exploreWorkspaces: ['explore', 'workspaces'] as const,
  file: (id: string) => ['file', id] as const,
  files: (wsId: string) => ['workspace', wsId, 'files'] as const,
  integrations: ['integrations'] as const,
  labels: ['labels'] as const,
  material: (id: string) => ['material', id] as const,
  materialDiscussions: (id: string) => ['material', id, 'discussions'] as const,
  materialRevisions: (id: string) => ['material', id, 'revisions'] as const,
  materials: (wsId: string) => ['workspace', wsId, 'materials'] as const,
  me: ['me'] as const,
  messages: (convId: string) => ['conversation', convId, 'messages'] as const,
  mistakes: ['mistakes'] as const,
  notifications: ['notifications'] as const,
  quiz: (id: string) => ['quiz', id] as const,
  quizzes: ['quizzes'] as const,
  search: (q: string) => ['search', q] as const,
  sourceUploadPolicy: ['source-upload-policy'] as const,
  tags: (kind: string) => ['tags', kind] as const,
  tasks: ['tasks'] as const,
  thinking: ['thinking'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  workspaceMembers: (id: string) => ['workspace', id, 'members'] as const,
  workspaceStats: (id: string) => ['workspace', id, 'stats'] as const,
  workspaces: (params?: unknown) => ['workspaces', params ?? null] as const,
};
