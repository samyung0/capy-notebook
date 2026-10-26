import { create } from 'zustand';
import { USE_MSW } from '@/api/auth';
import { api, isApiError, qk } from '@/api/client';
import type { useImportSources, useUploadSource } from '@/api/hooks';
import { ingestSlotsQuery } from '@/api/hooks';
import { FILE_NAME_CHARACTER_LIMIT } from '@/api/limits.generated';
import { queryClient } from '@/api/queryClient';
import type {
  FileKind,
  SourceFile,
  SourceImportAcceptedResponse,
  SourceUploadPolicy,
} from '@/api/types';
import { uploadRemoved } from '@/api/uploadTurn';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { trackQuotaBlocked } from '@/lib/analytics';
import { CopyError } from '@/lib/copyError';
import { deferStorageRefusal, describeError } from '@/lib/errors';
import { compressSource } from './sourceCompress';
import {
  parseSourceImportAcceptedResponse,
  SourceImportFailedError,
  SourceImportPollingTimeoutError,
  waitForSourceImport,
  withSourceImportRequestRetry,
} from './sourceImport';
import {
  fileReachedTerminal,
  MAX_FILES_PER_UPLOAD,
  mapWithConcurrency,
  needsIngestJob,
  type ParseMode,
  SOURCE_UPLOAD_CONCURRENCY,
  sourceCompression,
  splitSourceWave,
} from './sourceUpload';

export type SourceProvider = 'google' | 'microsoft';

/** Where one source is before it becomes a workspace file. Once `added`, the
 * file's own status (parsing, ready, failed) comes from the files cache. */
export type TransferStage =
  | 'waiting'
  | 'compressing'
  | 'uploading'
  | 'importing'
  | 'added'
  | 'background'
  | 'failed';

export interface SourceTransfer {
  error?: string;
  fileId?: string;
  key: string;
  kind: FileKind;
  name: string;
  provider?: SourceProvider;
  /** The upload's place in the gateway's line, while it waits for a turn. */
  queuePosition?: number;
  stage: TransferStage;
  uploadPct: number;
  workspaceId: string;
}

interface TransferRequest {
  chapterId: string | null;
  chapterName: string | null;
  key: string;
  kind: FileKind;
  name: string;
  parseMode: ParseMode;
}

export interface LocalTransferRequest extends TransferRequest {
  durationSeconds?: number;
  estimatedCreditMicros: number;
  file: File;
  pageCount?: number;
}

export interface RemoteTransferRequest extends TransferRequest {
  driveId?: string;
  fileId: string;
  provider: SourceProvider;
}

type StartTransfer = {
  importSources: ReturnType<typeof useImportSources>['mutateAsync'];
  uploadSource: ReturnType<typeof useUploadSource>['mutateAsync'];
  workspaceId: string;
} & (
  | {
      /** The uploader's caps the browser compresses to and checks before
       * sending (Epo 2026-10-24). */
      limits: Pick<SourceUploadPolicy, 'imageMaxBytes' | 'maxBytes'>;
      local: LocalTransferRequest[];
      remote?: never;
    }
  | { limits?: never; local?: never; remote: RemoteTransferRequest[] }
);

interface TransferState {
  transfers: SourceTransfer[];
  /** Sources whose bytes or import request have not reached the server yet.
   * Kept apart from `transfers` so hiding the panel keeps the unload guard. */
  unsent: number;
}

export const useSourceTransfers = create<TransferState>(() => ({
  transfers: [],
  unsent: 0,
}));

const running = new Set<AbortController>();
/** Each row's own cancel while its transfer runs (removeSourceTransfer). */
const rowAborts = new Map<string, AbortController>();

function patchTransfer(key: string, patch: Partial<SourceTransfer>) {
  useSourceTransfers.setState((state) => ({
    transfers: state.transfers.map((transfer) =>
      transfer.key === key ? { ...transfer, ...patch } : transfer
    ),
  }));
}

function releaseUnsent(count: number) {
  useSourceTransfers.setState((state) => ({
    unsent: Math.max(0, state.unsent - count),
  }));
}

/** Hides the panel. Running transfers keep going; their rows are gone. */
export function dismissSourceTransfers() {
  useSourceTransfers.setState({ transfers: [] });
}

/** Removes one row, cancelling its upload (Epo 2026-10-22): a file not yet
 * sent is never sent and counts as removed in its batch at once, one waiting in the gateway's line
 * gives its ticket back as removed, so its place goes to the next file, and
 * an upload in flight is aborted (the gateway counts it failed). An import
 * already queued on the server keeps going, and a finished row only hides. */
export function removeSourceTransfer(key: string) {
  rowAborts.get(key)?.abort(uploadRemoved);
  useSourceTransfers.setState((state) => ({
    transfers: state.transfers.filter((transfer) => transfer.key !== key),
  }));
}

/** Stops every transfer, for the mock scenario reset. */
export function resetSourceTransfers() {
  for (const controller of running) controller.abort();
  running.clear();
  useSourceTransfers.setState({ transfers: [], unsent: 0 });
}

export function sourceImportFailureReason(code: string) {
  switch (code) {
    case 'folder_too_large':
      return m.source_import_folder_too_large();
    case 'folder_empty':
      return m.source_import_folder_empty();
    case 'google_drive_scope_required':
      return m.source_import_google_reconnect();
    case 'file_too_large':
      return m.source_import_file_too_large();
    case 'unsupported_file':
      return m.source_unsupported_format();
    case 'provider_file_unavailable':
    case 'provider_download_refused':
      return m.source_import_file_unavailable();
    case 'invalid_name':
      return m.source_import_invalid_name({ max: FILE_NAME_CHARACTER_LIMIT });
    case 'source_import_cancelled':
      return m.source_import_cancelled();
    // Its pictures ran past the import's time limit (Q363).
    case 'import_too_slow':
      return m.source_import_too_slow();
    // The import worker's image checks (Epo 2026-10-24).
    case 'office_image_too_large':
      return m.error_office_image_too_large_title();
    case 'office_vector_image':
    case 'office_image_unsupported':
      return m.error_office_picture_unsupported_title();
    case 'office_unreadable':
      return m.error_office_unreadable_title();
    case 'source_image_too_large':
      return m.error_source_image_too_large_title();
    case 'image_unreadable':
      return m.source_image_unreadable();
    case 'import_result_missing':
    case 'invalid_import_response':
    case 'unknown_import_status':
      return m.source_import_invalid_response();
    default:
      return m.source_try_again();
  }
}

/** Short reason for a panel row and the merged toast: import codes by their
 * own copy, everything else by the app-wide error title. */
function transferFailureReason(error: unknown) {
  if (error instanceof SourceImportFailedError)
    return sourceImportFailureReason(error.code);
  // A refusal the browser makes before sending: its own copy.
  if (error instanceof CopyError) return error.message;
  return describeError(error).title;
}

/** One error toast per submission: each failure adds its file name under its
 * reason instead of stacking another toast. */
function failureToast(id: string) {
  const groups = new Map<string, string[]>();
  let count = 0;
  return (name: string, reason: string) => {
    count += 1;
    groups.set(reason, [...(groups.get(reason) ?? []), name]);
    userToast({
      description: [...groups]
        .map(([groupReason, names]) =>
          m.source_import_file_error({
            name: names.join(', '),
            reason: groupReason,
          })
        )
        .join('\n'),
      id,
      title:
        count === 1
          ? m.source_transfer_failed_one()
          : m.source_transfer_failed_many({ count }),
      variant: 'error',
    });
  };
}

async function freeIngestSlots() {
  if (USE_MSW) return MAX_FILES_PER_UPLOAD;
  const slots = await queryClient
    .fetchQuery({ ...ingestSlotsQuery(), staleTime: 0 })
    .catch(() => undefined);
  return Math.max(1, slots?.slotsFree ?? MAX_FILES_PER_UPLOAD);
}

/** Resolves once the file is ready or failed. The workspace event stream
 * patches the files cache while that workspace is open; the poll keeps the
 * next wave moving after the user navigates elsewhere. */
function waitForFileTerminal(
  workspaceId: string,
  fileId: string,
  signal: AbortSignal
) {
  const files = () =>
    queryClient.getQueryData<SourceFile[]>(qk.files(workspaceId));
  return new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: qk.files(workspaceId),
        refetchType: 'all',
      });
    }, 5000);
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (fileReachedTerminal(files(), fileId)) finish();
    });
    function finish() {
      clearInterval(poll);
      unsubscribe();
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish);
    if (signal.aborted || fileReachedTerminal(files(), fileId)) finish();
  });
}

/** Sends every source, even after one fails, and tracks each one in the
 * transfer panel. Runs outside the dialog so closing it changes nothing. */
export function startSourceTransfer(start: StartTransfer) {
  const { workspaceId } = start;
  const requests = start.local ?? start.remote;
  const controller = new AbortController();
  const { signal } = controller;
  running.add(controller);
  // A row's transfer stops with the whole transfer or its own remove (a
  // listener rather than AbortSignal.any, which Safari has only from 17.4).
  for (const request of requests) {
    const row = new AbortController();
    signal.addEventListener('abort', () => row.abort(signal.reason), {
      once: true,
    });
    rowAborts.set(request.key, row);
  }
  function rowSignal(key: string) {
    return rowAborts.get(key)?.signal ?? signal;
  }
  const toastFailure = failureToast(
    `source-transfer-failed-${crypto.randomUUID()}`
  );
  useSourceTransfers.setState((state) => ({
    transfers: [
      ...state.transfers,
      ...requests.map(
        (request): SourceTransfer => ({
          key: request.key,
          kind: request.kind,
          name: request.name,
          provider: 'provider' in request ? request.provider : undefined,
          stage: 'waiting',
          uploadPct: 0,
          workspaceId,
        })
      ),
    ],
    unsent: state.unsent + requests.length,
  }));

  // One notification batch for the whole submission.
  const batchId = crypto.randomUUID();
  /** Counts a file the user removed before the server heard of it as removed
   * in the batch, so its notification does not wait for the idle sweep. */
  function countRemoved(cancel: AbortSignal) {
    if (cancel.reason !== uploadRemoved) return;
    api
      .post(`/workspaces/${workspaceId}/sources/batches/${batchId}/removed`, {
        source: start.local ? 'upload' : 'import',
        total: requests.length,
      })
      .catch(() => undefined);
  }
  let unsent = requests.length;
  function sent() {
    unsent -= 1;
    releaseUnsent(1);
  }

  function fail(key: string, name: string, error: unknown) {
    if (signal.aborted || rowAborts.get(key)?.signal.aborted) return;
    trackQuotaBlocked(error, 'upload');
    const reason = transferFailureReason(error);
    patchTransfer(key, { error: reason, stage: 'failed' });
    // A frozen or storage refusal shows as the workspace status instead.
    if (!deferStorageRefusal(error)) toastFailure(name, reason);
  }

  /** Tells the user how many pictures nothing can show left a file (Epo
   * 2026-10-24, Q337). */
  function picturesRemovedToast(name: string, count: number) {
    if (count > 0)
      userToast({
        description:
          count === 1
            ? m.source_pictures_removed_body_one()
            : m.source_pictures_removed_body({ count }),
        title: m.source_pictures_removed({ name }),
        variant: 'warning',
      });
  }

  async function sendLocal(
    local: LocalTransferRequest[],
    limits: Pick<SourceUploadPolicy, 'imageMaxBytes' | 'maxBytes'>
  ) {
    let remaining = local;
    while (remaining.length > 0 && !signal.aborted) {
      const { wave, rest } = splitSourceWave(
        remaining,
        (request) =>
          needsIngestJob(request.name, request.kind, request.parseMode),
        await freeIngestSlots()
      );
      const waits: Promise<void>[] = [];
      // Each row settles as soon as its own upload does, not with the wave.
      await mapWithConcurrency(
        wave,
        SOURCE_UPLOAD_CONCURRENCY,
        async (request) => {
          const cancel = rowSignal(request.key);
          // Whether the server holds the upload's ticket, whose give-back
          // then counts a removed file.
          let ticketed = false;
          try {
            if (cancel.aborted) {
              countRemoved(cancel);
              return;
            }
            // Compressed first; the per-file cap applies to what is sent.
            let picked = request.file;
            let removed = 0;
            const compression = sourceCompression(request.name, request.kind);
            if (compression) {
              patchTransfer(request.key, { stage: 'compressing' });
              ({ file: picked, removed } = await compressSource(
                { compression, file: picked, ...limits },
                (uploadPct) => patchTransfer(request.key, { uploadPct }),
                cancel
              ));
            }
            if (picked.size > limits.maxBytes)
              throw new CopyError(
                m.source_files_too_large({
                  mb: Math.round(limits.maxBytes / 1024 / 1024),
                })
              );
            patchTransfer(request.key, {
              name: picked.name,
              stage: 'uploading',
              uploadPct: 0,
            });
            // An upload past the upload rate class waits in the gateway's
            // line (queuePosition); the browser never retries one (Q282).
            const file = await start.uploadSource({
              batchId,
              batchTotal: requests.length,
              chapterId: request.chapterId,
              chapterName: request.chapterName,
              durationSeconds: request.durationSeconds,
              estimatedCreditMicros: request.estimatedCreditMicros,
              file: picked,
              kind: request.kind,
              onQueued: (queuePosition) => {
                ticketed = true;
                patchTransfer(request.key, { queuePosition });
              },
              onUploadProgress: (uploadPct) =>
                patchTransfer(request.key, { uploadPct }),
              pageCount: request.pageCount,
              parseMode: request.parseMode,
              signal: cancel,
            });
            patchTransfer(request.key, {
              fileId: file.id,
              stage: 'added',
              uploadPct: 100,
            });
            picturesRemovedToast(picked.name, removed);
            if (needsIngestJob(request.name, request.kind, request.parseMode)) {
              waits.push(waitForFileTerminal(workspaceId, file.id, signal));
            }
          } catch (error) {
            if (!ticketed) countRemoved(cancel);
            fail(request.key, request.name, error);
          } finally {
            sent();
          }
        }
      );
      await Promise.all(waits);
      remaining = rest;
    }
  }

  function pollImport(key: string, name: string, jobId: string) {
    return waitForSourceImport(
      (id, pollSignal) =>
        api.get(`/workspaces/${workspaceId}/sources/imports/${id}`, {
          signal: pollSignal,
        }),
      jobId,
      // Mock imports give up sooner, so a pending scenario reaches the
      // background state.
      USE_MSW
        ? { maxWaitMilliseconds: 12_000, signal: rowSignal(key) }
        : { signal: rowSignal(key) }
    ).then(
      ({ fileId, name: stored, removedPictures }) => {
        patchTransfer(key, { fileId, name: stored, stage: 'added' });
        picturesRemovedToast(stored, removedPictures);
        void queryClient.invalidateQueries({ queryKey: qk.files(workspaceId) });
        // The upload counts as opening it (Recent).
        void queryClient.invalidateQueries({ queryKey: qk.recent });
      },
      (error: unknown) => {
        if (error instanceof SourceImportPollingTimeoutError) {
          patchTransfer(key, { stage: 'background' });
        } else {
          fail(key, name, error);
        }
      }
    );
  }

  async function sendRemote(remote: RemoteTransferRequest[]) {
    let remaining = remote;
    while (remaining.length > 0 && !signal.aborted) {
      const { wave, rest } = splitSourceWave(
        remaining,
        () => true,
        await freeIngestSlots()
      );
      const polls: Promise<void>[] = [];
      await mapWithConcurrency(
        wave,
        SOURCE_UPLOAD_CONCURRENCY,
        async (request) => {
          const cancel = rowSignal(request.key);
          if (cancel.aborted) {
            countRemoved(cancel);
            sent();
            return;
          }
          patchTransfer(request.key, { stage: 'importing' });
          // One id per request, so the request retries below stay idempotent.
          const requestId = crypto.randomUUID();
          // Whether the server may hold the item: an attempt was sent and not
          // refused with a status the server leaves uncounted (408, 429,
          // 5xx). A removal while it may be held is not counted here, since
          // the server counts the import itself.
          let held = false;
          let accepted: SourceImportAcceptedResponse;
          try {
            accepted = await withSourceImportRequestRetry(
              async () => {
                held = true;
                try {
                  return parseSourceImportAcceptedResponse(
                    await start.importSources({
                      batchId,
                      batchTotal: requests.length,
                      chapterId: request.chapterId,
                      chapterName: request.chapterName,
                      ...(request.driveId
                        ? { driveIds: [request.driveId] }
                        : {}),
                      fileIds: [request.fileId],
                      parseMode: request.parseMode,
                      provider: request.provider,
                      requestId,
                      signal: cancel,
                    }),
                    request.fileId
                  );
                } catch (error) {
                  if (
                    isApiError(error) &&
                    (error.status === 408 ||
                      error.status === 429 ||
                      error.status >= 500)
                  )
                    held = false;
                  throw error;
                }
              },
              undefined,
              cancel
            );
          } catch (error) {
            if (!held) countRemoved(cancel);
            fail(request.key, request.name, error);
            return;
          } finally {
            sent();
          }
          for (const item of accepted.rejected) {
            fail(
              request.key,
              request.name,
              new SourceImportFailedError(item.code, request.name)
            );
          }
          // A picked folder expands into one row per imported file.
          const rows = accepted.jobs.map((job, jobIndex) => ({
            job,
            key: jobIndex === 0 ? request.key : `${request.key}:${job.jobId}`,
          }));
          if (rows.length === 0) return;
          useSourceTransfers.setState((state) => ({
            transfers: state.transfers.flatMap((transfer) =>
              transfer.key === request.key
                ? rows.map(({ job, key }) => ({
                    ...transfer,
                    key,
                    name: job.name,
                    stage: 'importing' as const,
                  }))
                : [transfer]
            ),
          }));
          for (const { job, key } of rows) {
            polls.push(pollImport(key, job.name, job.jobId));
          }
        }
      );
      await Promise.all(polls);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.ingestSlots }),
        queryClient.invalidateQueries({ queryKey: qk.workspace(workspaceId) }),
        queryClient.invalidateQueries({
          queryKey: qk.workspaceStats(workspaceId),
        }),
      ]);
      remaining = rest;
    }
  }

  void (
    start.local
      ? sendLocal(start.local, start.limits)
      : sendRemote(start.remote)
  )
    .catch((error: unknown) => {
      // An unexpected runner error would otherwise leave rows spinning.
      const keys = requests.map((request) => request.key);
      for (const transfer of useSourceTransfers.getState().transfers) {
        const ours = keys.some(
          (key) => transfer.key === key || transfer.key.startsWith(`${key}:`)
        );
        if (
          ours &&
          ['waiting', 'uploading', 'importing'].includes(transfer.stage)
        ) {
          fail(transfer.key, transfer.name, error);
        }
      }
    })
    .finally(() => {
      running.delete(controller);
      for (const request of requests) rowAborts.delete(request.key);
      if (unsent > 0) releaseUnsent(unsent);
    });
}
