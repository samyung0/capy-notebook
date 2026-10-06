import { create } from 'zustand';
import { USE_MSW } from '@/api/auth';
import { api, qk } from '@/api/client';
import type { useImportSources, useUploadSource } from '@/api/hooks';
import { ingestSlotsQuery } from '@/api/hooks';
import { queryClient } from '@/api/queryClient';
import type {
  FileKind,
  SourceFile,
  SourceImportAcceptedResponse,
} from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { deferStorageRefusal, describeError } from '@/lib/errors';
import { trackQuotaBlocked } from '@/lib/observability';
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
  splitSourceWave,
  withUploadRetry,
} from './sourceUpload';

export type SourceProvider = 'google' | 'microsoft';

/** Where one source is before it becomes a workspace file. Once `added`, the
 * file's own status (parsing, ready, failed) comes from the files cache. */
export type TransferStage =
  | 'waiting'
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
  | { local: LocalTransferRequest[]; remote?: never }
  | { local?: never; remote: RemoteTransferRequest[] }
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
      return m.source_import_invalid_name();
    case 'source_import_cancelled':
      return m.source_import_cancelled();
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
  return error instanceof SourceImportFailedError
    ? sourceImportFailureReason(error.code)
    : describeError(error).title;
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
  let unsent = requests.length;
  function sent() {
    unsent -= 1;
    releaseUnsent(1);
  }

  function fail(key: string, name: string, error: unknown) {
    if (signal.aborted) return;
    trackQuotaBlocked(error, 'upload');
    const reason = transferFailureReason(error);
    patchTransfer(key, { error: reason, stage: 'failed' });
    // A frozen or storage refusal shows as the workspace status instead.
    if (!deferStorageRefusal(error)) toastFailure(name, reason);
  }

  async function sendLocal(local: LocalTransferRequest[]) {
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
          patchTransfer(request.key, { stage: 'uploading' });
          try {
            const file = await withUploadRetry(() =>
              start.uploadSource({
                batchId,
                batchTotal: requests.length,
                chapterId: request.chapterId,
                chapterName: request.chapterName,
                estimatedCreditMicros: request.estimatedCreditMicros,
                file: request.file,
                kind: request.kind,
                onUploadProgress: (uploadPct) =>
                  patchTransfer(request.key, { uploadPct }),
                pageCount: request.pageCount,
                parseMode: request.parseMode,
                signal,
              })
            );
            patchTransfer(request.key, {
              fileId: file.id,
              stage: 'added',
              uploadPct: 100,
            });
            if (needsIngestJob(request.name, request.kind, request.parseMode)) {
              waits.push(waitForFileTerminal(workspaceId, file.id, signal));
            }
          } catch (error) {
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
      USE_MSW ? { maxWaitMilliseconds: 12_000, signal } : { signal }
    ).then(
      (fileId) => {
        patchTransfer(key, { fileId, stage: 'added' });
        void queryClient.invalidateQueries({ queryKey: qk.files(workspaceId) });
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
          patchTransfer(request.key, { stage: 'importing' });
          // One id per request, so the request retries below stay idempotent.
          const requestId = crypto.randomUUID();
          let accepted: SourceImportAcceptedResponse;
          try {
            accepted = await withSourceImportRequestRetry(
              async () =>
                parseSourceImportAcceptedResponse(
                  await start.importSources({
                    batchId,
                    batchTotal: requests.length,
                    chapterId: request.chapterId,
                    chapterName: request.chapterName,
                    ...(request.driveId ? { driveIds: [request.driveId] } : {}),
                    fileIds: [request.fileId],
                    parseMode: request.parseMode,
                    provider: request.provider,
                    requestId,
                    signal,
                  }),
                  request.fileId
                ),
              undefined,
              signal
            );
          } catch (error) {
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

  void (start.local ? sendLocal(start.local) : sendRemote(start.remote))
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
      if (unsent > 0) releaseUnsent(unsent);
    });
}
