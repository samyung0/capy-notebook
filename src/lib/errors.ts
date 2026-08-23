import {
  isApiError,
  isCreditsExhaustedError,
  isFileLimitError,
  isInvalidLLMKeyError,
  isLLMKeyError,
  isLLMKeyFailedError,
  isModelUnavailableError,
  isStorageQuotaError,
  isTooManyIngestLeasesError,
} from '@/api/client';
import { m } from '@/i18n';

export type ErrorKind =
  | 'offline'
  | 'network'
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'quota'
  | 'files'
  | 'credits'
  | 'ingest'
  | 'model'
  | 'llmKey'
  | 'validation'
  | 'server'
  | 'chunkLoad'
  | 'cancelled'
  | 'unknown';

export type ErrorAction = 'reload' | 'retry' | 'signIn' | 'subscription';

export interface ErrorDescription {
  action?: ErrorAction;
  description: string;
  title: string;
}

const CHUNK_LOAD_PATTERN =
  /chunkloaderror|loading chunk \d+ failed|failed to fetch dynamically imported module|importing a module script failed/i;
const NETWORK_ERROR_PATTERN =
  /failed to fetch|networkerror|network error|load failed|connection refused|fetch failed/i;

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_LOAD_PATTERN.test(error.message);
}

function browserIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function errorKind(error: unknown): ErrorKind {
  if (isAbortError(error)) return 'cancelled';
  if (isChunkLoadError(error)) return 'chunkLoad';
  if (browserIsOffline()) return 'offline';
  if (isStorageQuotaError(error)) return 'quota';
  if (isFileLimitError(error)) return 'files';
  if (isCreditsExhaustedError(error)) return 'credits';
  if (isTooManyIngestLeasesError(error)) return 'ingest';
  if (isModelUnavailableError(error)) return 'model';
  if (isLLMKeyError(error)) return 'llmKey';

  if (isApiError(error)) {
    if (error.code === 'account_over_quota' || error.code === 'account_locked')
      return 'quota';
    if (error.status === 401) return 'auth';
    if (error.status === 403) return 'forbidden';
    if (error.status === 404) return 'notFound';
    if (error.status === 400 || error.status === 409 || error.status === 422)
      return 'validation';
    if (error.status >= 500) return 'server';
  }

  // fetch() throws TypeError('Failed to fetch'); other TypeErrors are bugs.
  if (isNetworkMessage(error)) return 'network';
  return 'unknown';
}

function isNetworkMessage(error: unknown): boolean {
  return error instanceof Error && NETWORK_ERROR_PATTERN.test(error.message);
}

export function isNonDisclosing(error: unknown): boolean {
  if (isCreditsExhaustedError(error)) return false;
  return (
    isApiError(error) &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export function describeError(error: unknown): ErrorDescription {
  switch (errorKind(error)) {
    case 'offline':
      return {
        description: m.error_offline_body(),
        title: m.error_offline_title(),
      };
    case 'network':
      return {
        action: 'retry',
        description: m.error_network_body(),
        title: m.error_network_title(),
      };
    case 'auth':
      return {
        action: 'signIn',
        description: m.error_auth_body(),
        title: m.error_auth_title(),
      };
    case 'forbidden':
      return {
        description: m.error_forbidden_body(),
        title: m.error_forbidden_title(),
      };
    case 'notFound':
      return {
        description: m.error_not_found_body(),
        title: m.error_not_found_title(),
      };
    case 'quota':
      return {
        action: 'subscription',
        description: m.error_quota_body(),
        title: m.error_quota_title(),
      };
    case 'files': {
      const limit =
        isFileLimitError(error) && typeof error.body?.filesLimit === 'number'
          ? error.body.filesLimit
          : 100;
      if (isApiError(error) && error.code === 'files_batch_exceeded') {
        return {
          description: m.error_files_batch_body({ limit }),
          title: m.error_files_batch_title(),
        };
      }
      return {
        description: m.error_files_limit_body({ limit }),
        title: m.error_files_limit_title(),
      };
    }
    case 'credits':
      return {
        action: 'subscription',
        description: m.error_credits_body(),
        title: m.error_credits_title(),
      };
    case 'ingest':
      return {
        description: m.error_ingest_slots_body(),
        title: m.error_ingest_slots_title(),
      };
    case 'model':
      return {
        description: m.error_model_unavailable_body(),
        title: m.error_model_unavailable_title(),
      };
    case 'llmKey':
      return {
        description: isInvalidLLMKeyError(error)
          ? m.settings_llm_key_invalid()
          : m.settings_llm_key_failed(),
        title: m.error_llm_key_title(),
      };
    case 'validation':
      return {
        description: m.error_validation_body(),
        title: m.error_validation_title(),
      };
    case 'server':
      return {
        action: 'retry',
        description: m.error_server_body(),
        title: m.error_server_title(),
      };
    case 'chunkLoad':
      return {
        action: 'reload',
        description: m.error_chunk_body(),
        title: m.error_chunk_title(),
      };
    case 'cancelled':
    case 'unknown':
      return {
        action: 'retry',
        description: m.error_generic_body(),
        title: m.error_generic_title(),
      };
  }
}

export function privateErrorDescription(): ErrorDescription {
  return {
    description: m.error_private_body(),
    title: m.error_private_title(),
  };
}

export function toastKeyFor(error: unknown): string {
  return `error:${errorKind(error)}`;
}

/** Maps provider-key failures from HTTP or stream payloads onto the settings copy. */
export function llmKeyUserMessage(error: unknown): string | null {
  if (isInvalidLLMKeyError(error)) return m.settings_llm_key_invalid();
  if (isLLMKeyFailedError(error)) return m.settings_llm_key_failed();
  const text = error instanceof Error ? error.message : String(error ?? '');
  const lower = text.toLowerCase();
  if (
    lower.includes('rejected this key') ||
    lower.includes('invalid_key') ||
    lower.includes('invalid_llm_key')
  ) {
    return m.settings_llm_key_invalid();
  }
  if (
    lower.includes('double check if the key') ||
    lower.includes('key_failed') ||
    lower.includes('llm_key_failed')
  ) {
    return m.settings_llm_key_failed();
  }
  return null;
}
