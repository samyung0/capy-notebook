import {
  isApiError,
  isCreditsExhaustedError,
  isModelUnavailableError,
  isStorageQuotaError,
} from '@/api/client';
import { m } from '@/i18n';

export type ErrorKind =
  | 'offline'
  | 'network'
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'quota'
  | 'credits'
  | 'model'
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
  if (isCreditsExhaustedError(error)) return 'credits';
  if (isModelUnavailableError(error)) return 'model';

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

  if (error instanceof TypeError || isNetworkMessage(error)) return 'network';
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
    case 'credits':
      return {
        action: 'subscription',
        description: m.error_credits_body(),
        title: m.error_credits_title(),
      };
    case 'model':
      return {
        description: m.error_model_unavailable_body(),
        title: m.error_model_unavailable_title(),
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
