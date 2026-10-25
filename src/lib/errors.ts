import {
  isApiError,
  isCreditsExhaustedError,
  isFileLimitError,
  isInvalidLLMKeyError,
  isLLMKeyError,
  isLLMKeyFailedError,
  isModelUnavailableError,
  isProviderBusyError,
  isStorageQuotaError,
  isTooManyIngestLeasesError,
  isWorkspaceLimitError,
} from '@/api/client';
// The generated limits, not the validators: this module loads on the
// summary page, whose script builds no Zod schema (zodJitless.ts).
import { FILE_NAME_CHARACTER_LIMIT } from '@/api/limits.generated';
import type { IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { CopyError } from './copyError';

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
  | 'busy'
  | 'llmKey'
  | 'validation'
  | 'sourceChanged'
  | 'server'
  | 'chunkLoad'
  | 'cancelled'
  | 'unknown';

export type ErrorAction = 'reload' | 'retry' | 'signIn' | 'subscription';

export interface ErrorDescription {
  action?: ErrorAction;
  description: string;
  /** Overrides ErrorState's default icon; toasts keep their variant icon. */
  icon?: IconName;
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

/** Work that failed because this device is offline, such as a page whose
 * code could not load (src/router.ts): described as offline even once the
 * connection is back, until the retry replaces it. */
export class OfflineError extends Error {}

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_LOAD_PATTERN.test(error.message);
}

function browserIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function errorKind(error: unknown): ErrorKind {
  if (isAbortError(error)) return 'cancelled';
  // Offline first: code that failed to load offline is no update to reload.
  if (error instanceof OfflineError || browserIsOffline()) return 'offline';
  if (isChunkLoadError(error)) return 'chunkLoad';
  if (isStorageQuotaError(error)) return 'quota';
  if (isFileLimitError(error)) return 'files';
  if (isWorkspaceLimitError(error)) return 'quota';
  if (isCreditsExhaustedError(error)) return 'credits';
  if (isTooManyIngestLeasesError(error)) return 'ingest';
  if (isModelUnavailableError(error)) return 'model';
  if (isProviderBusyError(error)) return 'busy';
  if (isLLMKeyError(error)) return 'llmKey';

  if (isApiError(error)) {
    if (error.code === 'source_changed') return 'sourceChanged';
    // A connection too slow for the gateway's 5-minute upload deadline.
    if (error.code === 'upload_timeout') return 'network';
    // An upload whose turn in the gateway's line passed, or whose ticket a
    // restart forgot: the user adds it again.
    if (error.code === 'upload_ticket_gone') return 'validation';
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

/** Copy for a server code whose status class alone would mislead. */
function codeCopy(code: string): ErrorDescription | null {
  switch (code) {
    case 'revision_conflict':
    case 'bank_conflict':
      return {
        action: 'reload',
        description: m.error_revision_conflict_body(),
        title: m.error_revision_conflict_title(),
      };
    case 'account_deletion_busy':
      return {
        description: m.error_account_deletion_busy_body(),
        title: m.error_account_deletion_busy_title(),
      };
    case 'subscription_exists':
      return {
        description: m.error_subscription_exists_body(),
        title: m.error_subscription_exists_title(),
      };
    case 'checkout_starting':
      return {
        description: m.error_checkout_starting_body(),
        title: m.error_checkout_starting_title(),
      };
    case 'subscription_active':
      return {
        description: m.error_subscription_active_body(),
        title: m.error_subscription_active_title(),
      };
    case 'account_state_changed':
      return {
        action: 'reload',
        description: m.error_account_state_changed_body(),
        title: m.error_account_state_changed_title(),
      };
    case 'clone_source_changed':
      return {
        action: 'retry',
        description: m.error_clone_source_changed_body(),
        title: m.error_clone_source_changed_title(),
      };
    case 'title_taken':
      return {
        description: m.error_title_taken_body(),
        title: m.error_title_taken_title(),
      };
    case 'too_many_chapters':
      return {
        description: m.error_too_many_chapters_body(),
        title: m.error_too_many_chapters_title(),
      };
    case 'transfer_self':
      return {
        description: m.error_transfer_self_body(),
        title: m.error_transfer_self_title(),
      };
    case 'workspace_limit_exceeded':
      return {
        action: 'subscription',
        description: m.error_workspace_limit_body(),
        title: m.error_workspace_limit_title(),
      };
    case 'too_many_streams':
      return {
        description: m.error_too_many_streams_body(),
        title: m.error_too_many_streams_title(),
      };
    case 'context_too_large':
      return {
        description: m.error_context_too_large_body(),
        title: m.error_context_too_large_title(),
      };
    case 'generate_empty':
      return {
        action: 'retry',
        description: m.error_generate_empty_body(),
        title: m.error_generate_empty_title(),
      };
    case 'scope_has_no_indexed_content':
      return {
        description: m.error_no_indexed_content_body(),
        title: m.error_no_indexed_content_title(),
      };
    case 'ai_unavailable':
      return {
        action: 'retry',
        description: m.error_ai_unavailable_body(),
        title: m.error_ai_unavailable_title(),
      };
    case 'trash_expired':
      return {
        description: m.error_trash_expired_body(),
        title: m.error_trash_expired_title(),
      };
    case 'operation_conflict':
      return {
        action: 'reload',
        description: m.error_operation_conflict_body(),
        title: m.error_operation_conflict_title(),
      };
    case 'nothing_to_process':
      return {
        description: m.error_nothing_to_process_body(),
        title: m.error_nothing_to_process_title(),
      };
    case 'processing_started':
      return {
        description: m.error_processing_started_body(),
        title: m.error_processing_started_title(),
      };
    case 'bank_unavailable':
    case 'bank_read_only':
    case 'bank_unconfigured':
      return {
        description: m.error_bank_unavailable_body(),
        title: m.error_bank_unavailable_title(),
      };
    // The gateway cut off an upload whose body took past its deadline; a
    // connection dropped first reads as a network error instead.
    case 'upload_timeout':
      return {
        action: 'retry',
        description: m.error_upload_timeout(),
        title: m.error_upload_timeout(),
      };
    case 'upload_ticket_gone':
      return {
        action: 'retry',
        description: m.error_upload_ticket_gone(),
        title: m.error_upload_ticket_gone(),
      };
    case 'upload_queue_full':
      return {
        action: 'retry',
        description: m.error_upload_queue_full_body(),
        title: m.error_upload_queue_full_title(),
      };
    // The gateway's image header checks (Epo 2026-10-24): final refusals.
    case 'image_too_large':
      return {
        description: m.error_image_too_large_body(),
        title: m.error_image_too_large_title(),
      };
    case 'image_unreadable':
      return {
        description: m.error_image_unreadable_body(),
        title: m.error_image_unreadable_title(),
      };
    case 'office_image_too_large':
      return {
        description: m.error_office_image_too_large_body(),
        title: m.error_office_image_too_large_title(),
      };
    case 'office_vector_image':
    case 'office_image_unsupported':
      return {
        description: m.error_office_picture_unsupported_body(),
        title: m.error_office_picture_unsupported_title(),
      };
    case 'office_unreadable':
      return {
        description: m.error_office_unreadable_body(),
        title: m.error_office_unreadable_title(),
      };
    case 'source_image_too_large':
      return {
        description: m.error_source_image_too_large_body(),
        title: m.error_source_image_too_large_title(),
      };
    // File names on upload and rename (Q346).
    case 'invalid_name':
      return {
        description: m.error_invalid_name_body({
          max: FILE_NAME_CHARACTER_LIMIT,
        }),
        title: m.error_invalid_name_title(),
      };
    case 'file_extension_changed':
      return {
        description: m.error_file_extension_changed_body(),
        title: m.error_file_extension_changed_title(),
      };
    // Count and size caps on rows kept outside storage, and daily caps.
    case 'grading_limit':
      return {
        description: m.error_grading_limit_body(),
        title: m.error_grading_limit_title(),
      };
    case 'invite_recently_sent':
      return {
        description: m.error_invite_recently_sent_body(),
        title: m.error_invite_recently_sent_title(),
      };
    case 'invite_limit':
      return {
        description: m.error_invite_limit_body(),
        title: m.error_invite_limit_title(),
      };
    case 'comment_limit':
      return {
        description: m.error_comment_limit_body(),
        title: m.error_comment_limit_title(),
      };
    case 'annotation_limit':
      return {
        description: m.error_annotation_limit_body(),
        title: m.error_annotation_limit_title(),
      };
    case 'event_limit':
      return {
        description: m.error_event_limit_body(),
        title: m.error_event_limit_title(),
      };
    case 'checkout_limit':
      return {
        description: m.error_checkout_limit_body(),
        title: m.error_checkout_limit_title(),
      };
    // The gateway's limiter could not count an AI or upload request.
    case 'rate_limit_unavailable':
      return {
        action: 'retry',
        description: m.error_rate_limit_unavailable_body(),
        title: m.error_rate_limit_unavailable_title(),
      };
    default:
      return null;
  }
}

export function describeError(error: unknown): ErrorDescription {
  const kind = errorKind(error);
  const coded =
    kind !== 'offline' && isApiError(error) && error.code
      ? codeCopy(error.code)
      : null;
  if (coded) return coded;
  switch (kind) {
    case 'offline':
      return {
        description: m.error_offline_body(),
        icon: 'wifiOff',
        title: m.error_offline_title(),
      };
    case 'network':
      return {
        action: 'retry',
        description: m.error_network_body(),
        icon: 'wifiError',
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
        icon: 'securityWarning',
        title: m.error_forbidden_title(),
      };
    case 'notFound':
      return {
        description: m.error_not_found_body(),
        title: m.error_not_found_title(),
      };
    case 'quota':
      // Outside a workspace an account refusal is the requester's own frozen
      // account (inside one, deferStorageRefusal routes it to the status).
      if (isAccountRefusal(error))
        return {
          action: 'subscription',
          description: m.account_frozen_short(),
          title: m.account_banner_frozen_title(),
        };
      // Without numbers the item is another account's, and that account is
      // full (uploader pays).
      if (isStorageQuotaError(error) && !error.body?.ownerUserId)
        return {
          description: m.storage_payer_full_body(),
          title: m.storage_payer_full_strip(),
        };
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
    case 'busy':
      return {
        action: 'retry',
        description: m.error_provider_busy_body(),
        title: m.error_provider_busy_title(),
      };
    case 'llmKey':
      return {
        description: isInvalidLLMKeyError(error)
          ? m.settings_llm_key_invalid()
          : m.settings_llm_key_failed(),
        title: m.error_llm_key_title(),
      };
    case 'sourceChanged':
      return {
        action: 'retry',
        description: m.error_source_changed_body(),
        icon: 'fileError',
        title: m.error_source_changed_title(),
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
        icon: 'error',
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

/** The 5xx codes with their own copy; the gateway keeps the same list
 * (`typedServerCodes`). Any other 5xx is unexpected, whatever it carries. */
const TYPED_SERVER_CODES = new Set([
  'ai_unavailable',
  'bank_unavailable',
  'generate_empty',
  'captcha_unavailable',
  'provider_busy',
  'rate_limit_unavailable',
  'transcription_failed',
  'upload_queue_full',
  'voice_unavailable',
]);

/** The trace id an error that stays on screen shows (a boundary, FormAlert,
 * a failed page or pane with Retry): only for an unexpected API failure, a
 * 5xx without a typed code or an unknown status without a code. Typed
 * refusals and toasts show none. */
export function unexpectedErrorId(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const typed =
    error.status >= 500
      ? TYPED_SERVER_CODES.has(error.code ?? '')
      : error.code !== null;
  if (typed) return null;
  const kind = errorKind(error);
  return kind === 'server' || kind === 'unknown' ? error.traceId : null;
}

export { CopyError } from './copyError';

/** Copy for a caught failure: a CopyError's own copy, API and connection
 * failures by their code, anything else (an exception) as `fallback`, never
 * the error's own text. */
export function errorCopy(error: unknown, fallback: string): string {
  if (error instanceof CopyError) return error.message;
  const kind = errorKind(error);
  return kind === 'unknown' || kind === 'cancelled'
    ? fallback
    : describeError(error).description;
}

/** A frozen account refused the write (the requester's or the owner's). */
export function isAccountRefusal(error: unknown): boolean {
  return isApiError(error) && error.code === 'account_over_quota';
}

/** A frozen account or a storage limit refused the write. */
export function isStorageRefusal(error: unknown): boolean {
  return isAccountRefusal(error) || isStorageQuotaError(error);
}

let workspaceRefusals: { handle: (error: unknown) => void } | null = null;
const deferred = new WeakSet<object>();

/** Registered by WorkspaceHealth while a workspace is open: it refreshes the
 * account and shows the viewer's own storage status instead. */
export function handleWorkspaceRefusals(handle: (error: unknown) => void) {
  const current = { handle };
  workspaceRefusals = current;
  return () => {
    if (workspaceRefusals === current) workspaceRefusals = null;
  };
}

/** Inside a workspace, a frozen or storage refusal goes to the workspace
 * status (the viewer's own account, who pays for what they add); true when it
 * did, so the caller (the mutation cache, or a surface with its own error
 * toast) shows nothing of its own. The status shows once per refusal however
 * many surfaces see it. Outside a workspace the caller keeps its own copy,
 * and so does a quota refusal without numbers: another account pays for that
 * item and is full (the numbers come only to the charged account). */
export function deferStorageRefusal(error: unknown): boolean {
  if (!workspaceRefusals || !isStorageRefusal(error)) return false;
  if (isStorageQuotaError(error) && !error.body?.ownerUserId) return false;
  if (!deferred.has(error as object)) {
    deferred.add(error as object);
    workspaceRefusals.handle(error);
  }
  return true;
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
