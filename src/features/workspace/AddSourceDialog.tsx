import { captureException } from '@sentry/react';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { authHeaders, USE_MSW } from '@/api/auth';
import {
  api,
  isCreditsExhaustedError,
  isFileLimitError,
  isStorageQuotaError,
  isTooManyIngestLeasesError,
  qk,
} from '@/api/client';
import { createSourceUploadBodyNameMax } from '@/api/gen/validators';
import {
  useChapters,
  useImportSources,
  useIngestSlots,
  useInspectSourceImports,
  useIntegrations,
  useSourceUploadPolicy,
  useUploadSource,
  useWorkspace,
} from '@/api/hooks';
import type {
  Chapter,
  FileKind,
  InspectSourceImportsResponse,
  MicrosoftDriveHost,
  SourceFile,
  SourceUploadPolicy,
} from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { GoogleIcon, OneDriveIcon } from '@/components/ui/BrandIcons';
import { Button } from '@/components/ui/Button';
import {
  DialogClose,
  DialogFooter,
  SimpleDialog,
} from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input, InputError } from '@/components/ui/Input';
import { ProgressBar } from '@/components/ui/ProgressBar';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Separator } from '@/components/ui/Separator';
import { Tabs } from '@/components/ui/Tabs';
import { userToast } from '@/components/ui/userToast';
import type { OpenItem } from '@/features/materials/openItem';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import {
  createGooglePicker,
  type GooglePicker,
  googlePickerEnv,
  loadGooglePicker,
} from '@/lib/googlePicker';
import {
  acquirePickerToken,
  assertMsalConfigured,
  clearPickerAuth,
} from '@/lib/msalPickerAuth';
import { trackQuotaBlocked } from '@/lib/observability';
import {
  type ImportSourceRef,
  isPickerConsentBlocked,
  isPickerUserCancelled,
  openOneDrivePicker,
  pickerLocale,
} from '@/lib/onedrivePicker';
import {
  useMicrosoftLoginHint,
  useProviderConnect,
} from '@/lib/useProviderConnect';
import { CreateFilePanel } from './CreateFilePanel';
import {
  calculateParseCreditMicros,
  localSourceAnalysisInput,
  SourceAnalysisCancelledError,
  type SourceAnalysisInput,
  type SourceAnalysisProgress,
  SourceAnalysisQueue,
  type SourceAnalysisResult,
} from './sourceAnalysis';
import {
  aggregateSourceAnalysis,
  initialAnalysisStatus,
  remoteSourceAnalysisInput,
  type SourceAnalysisStatus,
  sourceAnalysisBlocksSubmit,
  validateLocalSourceSelection,
} from './sourceDetails';
import {
  collectSourceImportResponses,
  parseSourceImportAcceptedResponse,
  SourceImportFailedError,
  SourceImportPollingTimeoutError,
  waitForSourceImportWave,
  withSourceImportRequestRetry,
} from './sourceImport';
import { createSourceInspectionGuard } from './sourceInspectionGuard';
import {
  aggregateUploadPct,
  capSourceUploads,
  chunkItems,
  defaultParseMode,
  fileReachedTerminal,
  getFileKind,
  isTextKind,
  MAX_FILES_PER_UPLOAD,
  MAX_FILES_PER_WORKSPACE,
  mapWithConcurrency,
  needsIngestJob,
  type ParseMode,
  parseModeIssues,
  SOURCE_UPLOAD_CONCURRENCY,
  shouldArmBeforeUnload,
  splitSourceWave,
  withUploadRetry,
} from './sourceUpload';

function reportPickerFailure(
  provider: Provider,
  stage: 'open' | 'selection' | 'configuration'
) {
  // Provider payloads and URLs can contain OAuth tokens and private file names.
  captureException(new Error('Cloud source picker failed'), {
    tags: { component: 'source-picker', provider, stage },
  });
}

type Provider = 'google' | 'microsoft';
export interface PendingSource {
  analysisInput?: SourceAnalysisInput;
  analysisProgress?: SourceAnalysisProgress;
  analysisResult?: SourceAnalysisResult;
  analysisStatus: SourceAnalysisStatus;
  audioDurationPending?: boolean;
  audioDurationSeconds?: number | null;
  chapterId: string | null;
  chapterName: string | null;
  contentType: string;
  driveId?: string;
  file?: File;
  fileId?: string;
  key: string;
  kind: FileKind;
  name: string;
  origin: 'local' | 'remote';
  parseMode: ParseMode;
  provider?: Provider;
  sizeBytes: number;
  sizeEstimate: boolean;
  uploadPct?: number;
}

function formatSize(bytes: number, estimated = false) {
  const value =
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return estimated ? `~${value}` : value;
}

function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const finish = (duration: number | null) => {
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () =>
      finish(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : null
      );
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

function useUnsentBeforeUnload(unsentCount: number) {
  useEffect(() => {
    if (!shouldArmBeforeUnload(unsentCount)) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsentCount]);
}

async function waitForFileTerminal(
  queryClient: QueryClient,
  workspaceId: string,
  fileId: string,
  signal?: AbortSignal
) {
  const files = () =>
    queryClient.getQueryData<SourceFile[]>(qk.files(workspaceId));
  if (signal?.aborted || fileReachedTerminal(files(), fileId)) return;
  await new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      signal?.removeEventListener('abort', finish);
      unsubscribe();
      resolve();
    };
    unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (fileReachedTerminal(files(), fileId)) finish();
    });
    signal?.addEventListener('abort', finish);
    if (signal?.aborted || fileReachedTerminal(files(), fileId)) finish();
  });
}

function workspaceFileRoom(
  workspace: { fileCount: number; filesLimit: number } | undefined
) {
  const filesUsed = workspace?.fileCount ?? 0;
  const filesLimit = workspace?.filesLimit ?? MAX_FILES_PER_WORKSPACE;
  return {
    filesLimit,
    filesUsed,
    workspaceRoom: Math.max(0, filesLimit - filesUsed),
  };
}

function workspaceRoomToast(workspaceRoom: number, filesLimit: number) {
  userToast({
    title:
      workspaceRoom <= 0
        ? m.source_workspace_file_full({ limit: filesLimit })
        : m.source_upload_too_many({ count: workspaceRoom }),
    variant: 'error',
  });
}

function fileLimitToast(
  error: unknown
): { description: string; title: string } | null {
  if (!isFileLimitError(error)) return null;
  const limit =
    typeof error.body?.filesLimit === 'number'
      ? error.body.filesLimit
      : MAX_FILES_PER_WORKSPACE;
  if (error.code === 'files_batch_exceeded') {
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

/** Server limit on files.name, counted in code points like the API. */
function nameTooLong(name: string): boolean {
  return [...name].length > createSourceUploadBodyNameMax;
}

function sourceImportFailureReason(code: string) {
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

function reportRejectedImports(rejected: { code: string; fileId: string }[]) {
  const counts = new Map<string, number>();
  for (const item of rejected) {
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  }
  for (const [code, count] of counts) {
    userToast({
      description: m.source_import_rejected_count({
        count,
        reason: sourceImportFailureReason(code),
      }),
      title: m.source_import_failed(),
      variant: 'error',
    });
  }
}

const NO_CHAPTER = '__none__';
const CREATE_CHAPTER = '__create__';

// Row pickers copy the code block language trigger: ghost, muted, no chevron.
export function ChapterSelect({
  chapters,
  value,
  chapterName,
  onChange,
  onCreateRequest,
  disabled = false,
}: {
  chapters: Chapter[];
  value: string | null;
  chapterName?: string | null;
  onChange: (value: string | null) => void;
  onCreateRequest?: () => void;
  disabled?: boolean;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(value) => {
        if (value === CREATE_CHAPTER) {
          onCreateRequest?.();
          return;
        }
        onChange(value === NO_CHAPTER ? null : value);
      }}
      value={value ?? NO_CHAPTER}
    >
      <SelectTrigger
        className="h-7 w-auto translate-y-px bg-transparent py-0 pr-1.5 pl-2 font-semibold text-fg-muted hover:text-fg"
        showDownIcon={false}
        size="sm"
        variant="ghost"
      >
        <span className="line-clamp-1 max-w-36">
          {chapterName ?? <SelectValue />}
        </span>
      </SelectTrigger>
      <SelectContent align="end" className="max-w-47">
        <SelectGroup>
          <SelectItem size="sm" value={NO_CHAPTER}>
            <span className="text-fg-muted">{m.source_no_chapter()}</span>
          </SelectItem>
          {chapters.map((chapter) => (
            <SelectItem key={chapter.id} size="sm" value={chapter.id}>
              <span className="line-clamp-1 translate-y-px">
                {chapter.name}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        {onCreateRequest && (
          <>
            <SelectSeparator />
            <SelectGroup className="scroll-my-0">
              <SelectItem size="sm" value={CREATE_CHAPTER}>
                <span className="flex items-center gap-1.5">
                  <Icon name="plus" size={14} />
                  {m.source_new_chapter()}
                </span>
              </SelectItem>
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

function hasParseModes(pending: PendingSource, policy: SourceUploadPolicy) {
  return pending.kind !== 'unknown' && !isTextKind(pending.kind, policy);
}

export function ParseModeSelect({
  pending,
  policy,
  onChange,
  disabled = false,
}: {
  pending: PendingSource;
  policy: SourceUploadPolicy;
  onChange: (mode: ParseMode) => void;
  disabled?: boolean;
}) {
  if (!hasParseModes(pending, policy)) return;
  const issues = parseModeIssues(
    { name: pending.name, size: pending.sizeBytes },
    pending.kind,
    policy,
    pending.analysisResult?.pageCount
  );
  return (
    <Select
      disabled={disabled}
      onValueChange={(value) => onChange(value as ParseMode)}
      value={pending.parseMode}
    >
      <SelectTrigger
        className="h-7 w-auto translate-y-px bg-transparent py-0 pr-1.5 pl-2 font-semibold text-fg-muted hover:text-fg"
        showDownIcon={false}
        size="sm"
        variant="ghost"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectItem disabled={Boolean(issues.fast)} size="sm" value="fast">
            {m.source_fast_parsing()}
            {issues.fast ? ` (${issues.fast})` : ''}
          </SelectItem>
          <SelectItem size="sm" value="none">
            {m.source_no_parsing()}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function localRows(
  selections: ReturnType<typeof validateLocalSourceSelection>['accepted'],
  policy: SourceUploadPolicy
): PendingSource[] {
  const now = Date.now();
  return selections.map(({ file, kind }, index) => {
    const key = `local-${now}-${index}-${file.name}`;
    const input = localSourceAnalysisInput(file, policy);
    return {
      analysisInput: input
        ? { ...input, key: `${key}\0${input.key}` }
        : undefined,
      analysisStatus: initialAnalysisStatus(
        file.name,
        input ?? undefined,
        policy
      ),
      audioDurationPending: kind === 'audio',
      chapterId: null,
      chapterName: null,
      contentType: file.type || 'application/octet-stream',
      file,
      key,
      kind,
      name: file.name,
      origin: 'local',
      parseMode: defaultParseMode(file, kind, policy),
      sizeBytes: file.size,
      sizeEstimate: false,
    };
  });
}

export type AddSourceMode = 'upload' | 'import' | 'create';

/** Expected cost of one source at the policy rates: audio by duration,
 * fast-parsed documents by digital/OCR page count, everything else free. */
function sourceCreditEstimate(
  source: Pick<
    PendingSource,
    'analysisResult' | 'audioDurationSeconds' | 'kind' | 'parseMode'
  >,
  uploadPolicy: SourceUploadPolicy
): number {
  if (source.kind === 'audio' && source.audioDurationSeconds != null) {
    return (
      Math.ceil(source.audioDurationSeconds) *
      uploadPolicy.audioSecondCreditMicros
    );
  }
  if (source.parseMode !== 'fast' || !source.analysisResult) return 0;
  return calculateParseCreditMicros(source.analysisResult, {
    digitalPageRateMicros: uploadPolicy.digitalParsePageCreditMicros,
    ocrPageRateMicros: uploadPolicy.ocrParsePageCreditMicros,
  });
}

type SourceBatch = ReturnType<typeof useSourceBatch>;

/** One tab's pending sources: analysis, row settings and submission. Upload
 * and Import each own one, so their lists never mix. */
function useSourceBatch(
  workspaceId: string,
  uploadPolicy: SourceUploadPolicy | undefined,
  initialSources: PendingSource[]
) {
  const { mutateAsync: uploadSource } = useUploadSource(workspaceId);
  const { mutateAsync: importSources } = useImportSources(workspaceId, {
    errorToast: false,
  });
  const { data: ingestSlots, refetch: refetchIngestSlots } = useIngestSlots({
    errorBoundary: false,
  });
  const queryClient = useQueryClient();
  const [sources, setSources] = useState(initialSources);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [unsentCount, setUnsentCount] = useState(0);
  const queueRef = useRef<SourceAnalysisQueue | null>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const drainAbort = useRef(new AbortController());
  const importRequestIds = useRef(new Map<string, string>());
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const initialRef = useRef(initialSources);

  const patchSource = useCallback(
    (key: string, patch: Partial<PendingSource>) => {
      setSources((current) =>
        current.map((source) =>
          source.key === key ? { ...source, ...patch } : source
        )
      );
    },
    []
  );

  // Read through a ref so a policy refetch cannot change this callback's
  // identity: the effect below tears down the queue and aborts uploads when
  // it does.
  const uploadPolicyRef = useRef(uploadPolicy);
  uploadPolicyRef.current = uploadPolicy;
  const enqueueAnalysis = useCallback(
    (source: PendingSource) => {
      const policy = uploadPolicyRef.current;
      if (source.parseMode !== 'fast' || !policy) return;
      if (!source.analysisInput) {
        // Fast-parsed by policy but not estimable here: say so rather than
        // leave the row idle behind a disabled Add button.
        patchSource(source.key, {
          analysisProgress: undefined,
          analysisStatus: initialAnalysisStatus(source.name, undefined, policy),
        });
        return;
      }
      const cached = queueRef.current?.getCached(source.analysisInput.key);
      if (cached) {
        patchSource(source.key, {
          analysisProgress: undefined,
          analysisResult: cached,
          analysisStatus: 'ready',
        });
        return;
      }
      patchSource(source.key, {
        analysisProgress: {
          completed: 0,
          percent: 0,
          phase: 'reading',
          total: 1,
        },
        analysisStatus: 'queued',
      });
      const job = queueRef.current?.enqueue({
        id: source.key,
        input: source.analysisInput,
        onProgress: (progress) =>
          patchSource(source.key, {
            analysisProgress: progress,
            analysisStatus: 'analyzing',
          }),
      });
      void job?.promise.then(
        (result) => {
          setSources((current) =>
            current.map((item) =>
              item.key === source.key && item.parseMode === 'fast'
                ? {
                    ...item,
                    analysisProgress: undefined,
                    analysisResult: result,
                    analysisStatus: 'ready',
                  }
                : item
            )
          );
        },
        (error) => {
          if (error instanceof SourceAnalysisCancelledError) return;
          patchSource(source.key, {
            analysisProgress: undefined,
            analysisStatus: 'error',
          });
        }
      );
    },
    [patchSource]
  );

  const inspectSource = useCallback(
    (source: PendingSource) => {
      enqueueAnalysis(source);
      if (source.kind === 'audio' && source.file) {
        void readAudioDuration(source.file).then((duration) =>
          patchSource(source.key, {
            audioDurationPending: false,
            audioDurationSeconds: duration,
          })
        );
      }
    },
    [enqueueAnalysis, patchSource]
  );

  useEffect(() => {
    const queue = new SourceAnalysisQueue();
    const drainController = new AbortController();
    queueRef.current = queue;
    drainAbort.current = drainController;
    for (const source of initialRef.current) inspectSource(source);
    return () => {
      queue.dispose();
      if (queueRef.current === queue) queueRef.current = null;
      drainAbort.current.abort();
      drainController.abort();
      for (const controller of uploadControllers.current.values()) {
        controller.abort();
      }
    };
  }, [inspectSource]);

  function add(rows: PendingSource[]) {
    // Picking the same cloud file twice keeps one row.
    const fresh = rows.filter(
      (row) => !sourcesRef.current.some((source) => source.key === row.key)
    );
    if (fresh.length === 0) return;
    sourcesRef.current = [...sourcesRef.current, ...fresh];
    setSources((current) => [...current, ...fresh]);
    for (const row of fresh) inspectSource(row);
  }

  function updateParseMode(source: PendingSource, parseMode: ParseMode) {
    if (parseMode === 'none') {
      queueRef.current?.cancel(source.key);
      patchSource(source.key, {
        analysisProgress: undefined,
        analysisStatus: source.analysisResult ? 'ready' : 'idle',
        parseMode,
      });
      return;
    }
    const next = { ...source, parseMode };
    patchSource(source.key, { parseMode });
    enqueueAnalysis(next);
  }

  function remove(source: PendingSource) {
    queueRef.current?.cancel(source.key);
    uploadControllers.current.get(source.key)?.abort();
    setSources((current) => current.filter((item) => item.key !== source.key));
  }

  function handleSubmitError(error: unknown, operation: 'import' | 'upload') {
    const fileToast = fileLimitToast(error);
    const importError =
      error instanceof SourceImportFailedError ? error : undefined;
    trackQuotaBlocked(error, 'upload');
    userToast({
      description: isCreditsExhaustedError(error)
        ? m.error_credits_body()
        : isTooManyIngestLeasesError(error)
          ? m.error_ingest_slots_body()
          : isStorageQuotaError(error)
            ? m.error_quota_body()
            : (fileToast?.description ??
              (importError
                ? sourceImportFailureReason(importError.code)
                : undefined)),
      title: isCreditsExhaustedError(error)
        ? m.error_credits_title()
        : isTooManyIngestLeasesError(error)
          ? m.error_ingest_slots_title()
          : isStorageQuotaError(error)
            ? m.error_quota_title()
            : (fileToast?.title ??
              (operation === 'import'
                ? m.source_import_failed()
                : m.source_upload_failed())),
      variant: 'error',
    });
  }

  async function submitLocal(
    localSources: PendingSource[],
    policy: SourceUploadPolicy
  ) {
    let remaining = [...localSources];
    const failed: PendingSource[] = [];
    while (remaining.length > 0 && !drainAbort.current.signal.aborted) {
      const slotsFree = Math.max(
        1,
        USE_MSW
          ? MAX_FILES_PER_UPLOAD
          : (ingestSlots?.slotsFree ?? MAX_FILES_PER_UPLOAD)
      );
      const { wave, rest } = splitSourceWave(
        remaining,
        (source) => needsIngestJob(source.name, source.kind, source.parseMode),
        slotsFree
      );
      if (wave.length === 0) continue;
      const results = await mapWithConcurrency(
        wave,
        SOURCE_UPLOAD_CONCURRENCY,
        (source) => {
          if (!source.file) throw new Error('missing local file');
          const file = source.file;
          const controller = new AbortController();
          uploadControllers.current.set(source.key, controller);
          return withUploadRetry(() =>
            uploadSource({
              chapterId: source.chapterId,
              chapterName: source.chapterName,
              estimatedCreditMicros: sourceCreditEstimate(source, policy),
              file,
              kind: source.kind,
              onUploadProgress: (uploadPct) =>
                patchSource(source.key, { uploadPct }),
              parseMode: source.parseMode,
              signal: controller.signal,
            })
          ).finally(() => uploadControllers.current.delete(source.key));
        }
      );
      const waits: Promise<void>[] = [];
      results.forEach((result, index) => {
        const source = wave[index];
        if (!source) return;
        if (result.status === 'rejected') {
          failed.push(source);
          handleSubmitError(result.reason, 'upload');
        } else if (needsIngestJob(source.name, source.kind, source.parseMode)) {
          waits.push(
            waitForFileTerminal(
              queryClient,
              workspaceId,
              result.value.id,
              drainAbort.current.signal
            )
          );
        }
      });
      await Promise.all(waits);
      remaining = rest;
    }
    return failed;
  }

  async function submitRemote(remoteSources: PendingSource[]) {
    let remaining = [...remoteSources];
    const failed: PendingSource[] = [];
    while (remaining.length > 0 && !drainAbort.current.signal.aborted) {
      const { data: slots } = await refetchIngestSlots();
      const { wave, rest } = splitSourceWave(
        remaining,
        () => true,
        Math.max(1, slots?.slotsFree ?? MAX_FILES_PER_UPLOAD)
      );
      const requests = wave.map((source) => {
        const key = JSON.stringify([
          source.provider,
          source.fileId,
          source.driveId ?? '',
          source.chapterId ?? '',
          source.chapterName ?? '',
          source.parseMode,
        ]);
        let requestId = importRequestIds.current.get(key);
        if (!requestId) {
          requestId = crypto.randomUUID();
          importRequestIds.current.set(key, requestId);
        }
        return { key, requestId, source };
      });
      const results = await mapWithConcurrency(
        requests,
        SOURCE_UPLOAD_CONCURRENCY,
        ({ requestId, source }) =>
          withSourceImportRequestRetry(
            async () =>
              parseSourceImportAcceptedResponse(
                await importSources({
                  chapterId: source.chapterId,
                  chapterName: source.chapterName,
                  ...(source.driveId ? { driveIds: [source.driveId] } : {}),
                  fileIds: [source.fileId ?? ''],
                  parseMode: source.parseMode,
                  provider: source.provider ?? 'google',
                  requestId,
                  signal: drainAbort.current.signal,
                }),
                source.fileId
              ),
            undefined,
            drainAbort.current.signal
          )
      );
      const jobSources = new Map<string, PendingSource>();
      const jobRequestKeys = new Map<string, string>();
      results.forEach((result, index) => {
        const request = requests[index];
        if (!request || result.status !== 'fulfilled') return;
        if (result.value.jobs.length === 0) {
          importRequestIds.current.delete(request.key);
        }
        for (const job of result.value.jobs) {
          jobSources.set(job.jobId, request.source);
          jobRequestKeys.set(job.jobId, request.key);
        }
      });
      const { jobs, rejected, requestErrors } =
        collectSourceImportResponses(results);
      reportRejectedImports(rejected);
      for (const error of requestErrors) handleSubmitError(error, 'import');
      results.forEach((result, index) => {
        if (result.status === 'rejected' && requests[index]) {
          failed.push(requests[index].source);
        }
      });
      const rejectedIds = new Set(rejected.map((item) => item.fileId));
      failed.push(
        ...wave.filter((source) =>
          source.fileId ? rejectedIds.has(source.fileId) : false
        )
      );
      const { completedJobIds, failures } = await waitForSourceImportWave(
        (jobId, signal) =>
          api.get(`/workspaces/${workspaceId}/sources/imports/${jobId}`, {
            signal,
          }),
        jobs,
        { signal: drainAbort.current.signal }
      );
      for (const jobId of completedJobIds) {
        const requestKey = jobRequestKeys.get(jobId);
        if (requestKey) importRequestIds.current.delete(requestKey);
      }
      for (const failure of failures) {
        const source = jobSources.get(failure.job.jobId);
        if (source) failed.push(source);
        if (failure.error instanceof SourceImportPollingTimeoutError) {
          userToast({
            description: m.source_import_background_files({
              names: failure.job.name,
            }),
            title: m.source_import_background_title(),
          });
        } else {
          const requestKey = jobRequestKeys.get(failure.job.jobId);
          if (requestKey) importRequestIds.current.delete(requestKey);
          handleSubmitError(failure.error, 'import');
        }
      }
      if (jobs.length > 0) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: qk.files(workspaceId) }),
          queryClient.invalidateQueries({ queryKey: qk.ingestSlots }),
          queryClient.invalidateQueries({
            queryKey: qk.workspace(workspaceId),
          }),
          queryClient.invalidateQueries({
            queryKey: qk.workspaceStats(workspaceId),
          }),
        ]);
      }
      remaining = rest;
    }
    return failed;
  }

  /** Sends every row; failed rows stay listed. Resolves true when all went. */
  async function submit() {
    if (isSubmitting || sources.length === 0 || !uploadPolicy) return false;
    const controller = new AbortController();
    drainAbort.current = controller;
    setIsSubmitting(true);
    setSources((current) =>
      current.map((source) =>
        source.origin === 'local' ? { ...source, uploadPct: 0 } : source
      )
    );
    setUnsentCount(sources.length);
    try {
      const localFailed = await submitLocal(
        sources.filter((source) => source.origin === 'local'),
        uploadPolicy
      );
      const remoteFailed = await submitRemote(
        sources.filter((source) => source.origin === 'remote')
      );
      if (controller.signal.aborted) return false;
      const failed = [
        ...new Map(
          [...localFailed, ...remoteFailed].map((source) => [
            source.key,
            source,
          ])
        ).values(),
      ];
      setSources(failed);
      return failed.length === 0;
    } finally {
      if (!controller.signal.aborted) {
        setIsSubmitting(false);
        setUnsentCount(0);
      }
    }
  }

  return {
    add,
    isSubmitting,
    patchSource,
    remove,
    sources,
    submit,
    unsentCount,
    updateParseMode,
  };
}

function SourceList({
  batch,
  disabled,
  uploadPolicy,
  workspaceId,
}: {
  batch: SourceBatch;
  disabled: boolean;
  uploadPolicy: SourceUploadPolicy;
  workspaceId: string;
}) {
  const { data: chapters } = useChapters(workspaceId, {
    errorBoundary: false,
  });
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [newChapterName, setNewChapterName] = useState('');

  function confirmCreateChapter(key: string) {
    const name = newChapterName.trim();
    if (!name) return;
    const existing = chapters?.find(
      (chapter) => chapter.name.toLowerCase() === name.toLowerCase()
    );
    batch.patchSource(key, {
      chapterId: existing?.id ?? null,
      chapterName: existing ? null : name,
    });
    setCreatingKey(null);
    setNewChapterName('');
  }

  return (
    <>
      <Separator className="mt-4.5 mb-3" />
      <h3 className="t-subtitle mb-2.5 shrink-0">
        {m.source_selected_files()}
      </h3>
      <ul className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        {batch.sources.map((source) => (
          <li
            className={cn(
              'flex shrink-0 flex-col gap-1 rounded-card border border-line py-2.5 pr-2 pl-3',
              { 'border-solid-error': nameTooLong(source.name) }
            )}
            key={source.key}
          >
            <div className="flex items-center gap-2">
              <FileIcon
                className="size-4 shrink-0"
                name={fileIconName(source)}
              />
              <span
                className="t-subtitle min-w-0 flex-1 truncate"
                title={source.name}
              >
                {source.name}
              </span>
              <IconButton
                className="p-2 text-fg-muted"
                disabled={disabled}
                icon="x"
                label={m.source_remove_file()}
                onClick={() => batch.remove(source)}
                size="sm"
                variant="ghost-hover"
              />
            </div>
            {nameTooLong(source.name) && (
              <InputError>
                {m.source_name_too_long({
                  max: createSourceUploadBodyNameMax,
                })}
              </InputError>
            )}
            <div className="flex flex-wrap items-center gap-x-3">
              <span className="t-meta pl-0.5 text-fg-muted">
                {formatSize(source.sizeBytes, source.sizeEstimate)} ·{' '}
                {source.kind.toUpperCase()}
              </span>
              <div className="ml-auto flex items-center">
                {creatingKey === source.key ? (
                  <div className="flex items-center">
                    <Input
                      autoFocus
                      disabled={disabled}
                      onChange={(event) =>
                        setNewChapterName(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          confirmCreateChapter(source.key);
                        }
                        if (event.key === 'Escape') setCreatingKey(null);
                      }}
                      placeholder={m.source_new_chapter_name()}
                      size="sm"
                      value={newChapterName}
                      variant="underline"
                    />
                    <IconButton
                      disabled={disabled || !newChapterName.trim()}
                      icon="check"
                      label={m.source_create_chapter()}
                      onClick={() => confirmCreateChapter(source.key)}
                      size="xs"
                      variant="ghost-hover"
                    />
                  </div>
                ) : (
                  <ChapterSelect
                    chapterName={source.chapterName}
                    chapters={chapters ?? []}
                    disabled={disabled}
                    onChange={(chapterId) =>
                      batch.patchSource(source.key, {
                        chapterId,
                        chapterName: null,
                      })
                    }
                    onCreateRequest={() => {
                      setCreatingKey(source.key);
                      setNewChapterName('');
                    }}
                    value={source.chapterId}
                  />
                )}
                {hasParseModes(source, uploadPolicy) && (
                  <>
                    <span aria-hidden className="text-fg-muted text-xs">
                      ·
                    </span>
                    <ParseModeSelect
                      disabled={disabled}
                      onChange={(mode) => batch.updateParseMode(source, mode)}
                      pending={source}
                      policy={uploadPolicy}
                    />
                  </>
                )}
              </div>
            </div>
            {source.parseMode === 'fast' &&
              (source.analysisStatus === 'error' ? (
                <p className="t-meta text-tint-error-fg">
                  {source.analysisInput
                    ? m.source_analysis_failed()
                    : m.source_analysis_unsupported()}
                </p>
              ) : (
                source.analysisStatus !== 'idle' &&
                source.analysisStatus !== 'ready' && (
                  <div className="flex flex-col gap-1">
                    <ProgressBar
                      height={4}
                      value={source.analysisProgress?.percent ?? 0}
                    />
                    <p className="t-meta text-fg-muted">
                      {m.source_analyzing_progress({
                        percent: Math.round(
                          source.analysisProgress?.percent ?? 0
                        ),
                      })}
                    </p>
                  </div>
                )
              ))}
            {source.kind === 'audio' && (
              <p
                className={cn('t-meta text-fg-muted', {
                  'text-tint-error-fg':
                    source.audioDurationSeconds != null &&
                    source.audioDurationSeconds >
                      uploadPolicy.audioMaxDurationSeconds,
                })}
              >
                {source.audioDurationPending
                  ? m.source_audio_reading_duration()
                  : source.audioDurationSeconds == null
                    ? m.source_audio_estimate_unavailable()
                    : source.audioDurationSeconds >
                        uploadPolicy.audioMaxDurationSeconds
                      ? m.source_audio_too_long({
                          hours: uploadPolicy.audioMaxDurationSeconds / 3600,
                        })
                      : m.source_audio_estimate({
                          cost: (
                            (Math.ceil(source.audioDurationSeconds) *
                              uploadPolicy.audioSecondCreditMicros) /
                            1_000_000
                          ).toLocaleString(),
                          minutes: Math.ceil(source.audioDurationSeconds / 60),
                        })}
              </p>
            )}
            {source.uploadPct != null && (
              <ProgressBar height={4} value={source.uploadPct} />
            )}
          </li>
        ))}
      </ul>
      <p className="t-meta mt-3 shrink-0 text-fg-muted">
        {m.source_parse_hint({
          mb: Math.round(uploadPolicy.maxBytes / 1024 / 1024),
        })}
      </p>
      {batch.isSubmitting && (
        <ProgressBar
          className="mt-3 shrink-0"
          showLabel
          value={aggregateUploadPct(
            batch.sources
              .filter((source) => source.origin === 'local')
              .map((source) => ({
                size: source.sizeBytes,
                uploadPct: source.uploadPct,
              }))
          )}
        />
      )}
    </>
  );
}

function SourceFooter({
  batch,
  busy,
  label,
  onSubmit,
  uploadPolicy,
}: {
  batch: SourceBatch;
  busy: boolean;
  label: string;
  onSubmit: () => void;
  uploadPolicy: SourceUploadPolicy | undefined;
}) {
  const { sources } = batch;
  const analysisTotals = aggregateSourceAnalysis(
    sources
      .filter((source) => source.parseMode === 'fast')
      .map((source) => source.analysisResult)
  );
  const estimatedCreditMicros = uploadPolicy
    ? sources.reduce(
        (total, source) => total + sourceCreditEstimate(source, uploadPolicy),
        0
      )
    : 0;
  const blocked =
    !uploadPolicy ||
    sources.some(
      (source) =>
        source.audioDurationPending ||
        (source.audioDurationSeconds != null &&
          source.audioDurationSeconds > uploadPolicy.audioMaxDurationSeconds) ||
        sourceAnalysisBlocksSubmit(source, uploadPolicy) ||
        source.analysisStatus === 'error' ||
        nameTooLong(source.name)
    );
  return (
    <DialogFooter className="shrink-0 items-center sm:justify-between">
      <div className="t-meta flex-1 text-fg-muted">
        {analysisTotals.pages > 0 &&
          m.source_analysis_summary({
            cost: (estimatedCreditMicros / 1_000_000).toLocaleString(),
            ocr: analysisTotals.ocrPages,
            text: analysisTotals.textPages,
          })}
      </div>
      <div className="flex gap-2">
        <DialogClose asChild>
          <Button disabled={busy} size="lg" variant="ghost-hover">
            {m.action_cancel()}
          </Button>
        </DialogClose>
        <Button
          disabled={sources.length === 0 || busy || blocked}
          onClick={onSubmit}
          size="lg"
          variant="accent"
        >
          {label}
        </Button>
      </div>
    </DialogFooter>
  );
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes('Files');
}

export function AddSourceDialog({
  open,
  onClose,
  workspaceId,
  initialMode = 'upload',
  initialSources = [],
  onOpenItem,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** Opens what the Create tab made. */
  onOpenItem?: (item: OpenItem) => void;
  /** Tab to open on: the plus menu lands New file on `create`. */
  initialMode?: AddSourceMode;
  /** Rows to start with, for the dev dialog previews. */
  initialSources?: PendingSource[];
}) {
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const { data: uploadPolicy } = useSourceUploadPolicy(workspaceId, {
    errorBoundary: false,
  });
  const [mode, setMode] = useState<string>(initialMode);
  const [inspectionGuard] = useState(createSourceInspectionGuard);
  const uploads = useSourceBatch(
    workspaceId,
    uploadPolicy,
    initialSources.filter((source) => source.origin === 'local')
  );
  const imports = useSourceBatch(
    workspaceId,
    uploadPolicy,
    initialSources.filter((source) => source.origin === 'remote')
  );
  const isSubmitting = uploads.isSubmitting || imports.isSubmitting;
  useUnsentBeforeUnload(uploads.unsentCount + imports.unsentCount);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [googlePickerOpen, setGooglePickerOpen] = useState(false);
  const pickerBusy = useRef(false);
  const googlePicker = useRef<GooglePicker | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: integrations } = useIntegrations({ errorBoundary: false });
  const { mutateAsync: inspectSources, isPending: isInspecting } =
    useInspectSourceImports(workspaceId, { errorToast: false });
  const connectProvider = useProviderConnect();
  const microsoftLoginHint = useMicrosoftLoginHint();
  const { filesLimit, filesUsed, workspaceRoom } = workspaceFileRoom(workspace);
  // Rows waiting in either list already claim workspace room.
  const pendingCount = uploads.sources.length + imports.sources.length;
  const canAdd = workspaceRoom > pendingCount && !isSubmitting;

  useEffect(() => {
    if (!open) {
      inspectionGuard.invalidate();
      googlePicker.current?.dispose();
      googlePicker.current = null;
      pickerBusy.current = false;
      setIsPicking(false);
      setGooglePickerOpen(false);
    }
  }, [inspectionGuard, open]);

  useEffect(
    () => () => {
      inspectionGuard.invalidate();
      googlePicker.current?.dispose();
    },
    [inspectionGuard]
  );

  function closeDialog() {
    if (isSubmitting) return;
    inspectionGuard.invalidate();
    onClose();
  }

  async function submit(batch: SourceBatch, other: SourceBatch) {
    // Keep the dialog open while the other tab still has rows to send.
    if ((await batch.submit()) && other.sources.length === 0) onClose();
  }

  function acceptLocalFiles(list: FileList | null) {
    if (!list?.length) return;
    if (!uploadPolicy) {
      userToast({
        description: m.source_formats_loading_body(),
        title: m.source_formats_loading_title(),
        variant: 'error',
      });
      return;
    }
    const selected = validateLocalSourceSelection(
      Array.from(list),
      uploadPolicy
    );
    const oversized = selected.rejected.filter(
      (item) => item.reason === 'file_too_large'
    );
    if (oversized.length > 0) {
      userToast({
        description: oversized.map((item) => item.file.name).join(', '),
        title: m.source_files_too_large({
          mb: Math.round(uploadPolicy.maxBytes / 1024 / 1024),
        }),
        variant: 'error',
      });
    }
    const capped = capSourceUploads(
      pendingCount,
      selected.accepted,
      workspaceRoom
    );
    if (capped.rejected > 0) workspaceRoomToast(workspaceRoom, filesLimit);
    if (capped.accepted.length > 0) {
      uploads.add(localRows(capped.accepted, uploadPolicy));
    }
    if (inputRef.current) inputRef.current.value = '';
  }

  function handlePickerError(error: unknown) {
    userToast({
      description: error instanceof Error ? error.message : undefined,
      title: m.source_import_failed(),
      variant: 'error',
    });
  }

  async function inspect(
    provider: Provider,
    refs: ImportSourceRef[],
    isCurrent = inspectionGuard.begin()
  ) {
    if (!uploadPolicy) return;
    const capped = capSourceUploads(pendingCount, refs, workspaceRoom);
    if (capped.rejected > 0) workspaceRoomToast(workspaceRoom, filesLimit);
    if (capped.accepted.length === 0) return;
    const inspectionKey = crypto.randomUUID();
    try {
      const inspections: InspectSourceImportsResponse[] = [];
      for (const batch of chunkItems(capped.accepted, MAX_FILES_PER_UPLOAD)) {
        const driveIds = batch.map((ref) => ref.driveId ?? '');
        const result = await inspectSources({
          ...(provider === 'microsoft' && driveIds.some(Boolean)
            ? { driveIds }
            : {}),
          fileIds: batch.map((ref) => ref.id),
          provider,
        });
        if (!isCurrent()) return;
        inspections.push(result);
      }
      const inspection = {
        items: inspections.flatMap((result) => result.items),
        rejected: inspections.flatMap((result) => result.rejected),
      };
      reportRejectedImports(inspection.rejected);
      const uniqueItems = [
        ...new Map(
          inspection.items.map((item) => [
            `${item.driveId ?? ''}:${item.fileId}`,
            item,
          ])
        ).values(),
      ];
      const selected = capSourceUploads(
        pendingCount,
        uniqueItems,
        workspaceRoom
      );
      if (selected.rejected > 0) workspaceRoomToast(workspaceRoom, filesLimit);
      if (selected.accepted.length === 0) return;
      const headers = await authHeaders();
      if (!isCurrent()) return;
      const rows: PendingSource[] = selected.accepted.map((item) => {
        const kind = getFileKind(item.name, uploadPolicy);
        const analysisInput = remoteSourceAnalysisInput(
          item,
          provider,
          headers,
          inspectionKey,
          uploadPolicy
        );
        return {
          analysisInput,
          analysisStatus: initialAnalysisStatus(
            item.name,
            analysisInput,
            uploadPolicy
          ),
          chapterId: null,
          chapterName: null,
          contentType: item.contentType,
          driveId: item.driveId,
          fileId: item.fileId,
          key: `remote-${provider}-${item.driveId ?? ''}-${item.fileId}`,
          kind,
          name: item.name,
          origin: 'remote',
          parseMode: defaultParseMode(
            { name: item.name, size: item.sizeBytes },
            kind,
            uploadPolicy
          ),
          provider,
          sizeBytes: item.sizeBytes,
          sizeEstimate: item.sizeEstimate,
        };
      });
      if (!isCurrent()) return;
      imports.add(rows);
    } catch (error) {
      if (!isCurrent()) return;
      handlePickerError(error);
    }
  }

  async function connect(provider: Provider) {
    if (USE_MSW) {
      await inspect(provider, [{ id: 'mock_drive_file' }]);
      return;
    }
    try {
      await connectProvider(provider);
    } catch (error) {
      userToast({
        description:
          error instanceof Error ? error.message : m.source_try_again(),
        title: m.source_connect_failed({ provider }),
        variant: 'error',
      });
    }
  }

  async function openGooglePicker() {
    if (pickerBusy.current) return;
    if (USE_MSW) {
      await inspect('google', [{ id: 'mock_drive_file' }]);
      return;
    }
    pickerBusy.current = true;
    setIsPicking(true);
    const isCurrent = inspectionGuard.begin();
    try {
      const { apiKey, appId } = googlePickerEnv();
      const { accessToken } = await api.get<{ accessToken: string }>(
        '/integrations/google/picker-token'
      );
      await loadGooglePicker();
      if (!isCurrent()) return;
      const picker = createGooglePicker({
        accessToken,
        apiKey,
        appId,
        onResult: (data) => {
          if (!isCurrent()) return;
          googlePicker.current?.dispose();
          googlePicker.current = null;
          setGooglePickerOpen(false);
          pickerBusy.current = false;
          setIsPicking(false);
          if (data.action === 'error') {
            reportPickerFailure('google', 'selection');
            handlePickerError(new Error(m.source_try_again()));
          } else if (data.action === 'picked' && data.docs?.length) {
            void inspect(
              'google',
              data.docs.map(({ id }) => ({ id })),
              isCurrent
            );
          }
        },
      });
      googlePicker.current = picker;
      // Remove Radix's focus trap and body pointer lock before Google opens.
      flushSync(() => setGooglePickerOpen(true));
      picker.setVisible(true);
    } catch (error) {
      if (!isCurrent()) return;
      googlePicker.current?.dispose();
      googlePicker.current = null;
      setGooglePickerOpen(false);
      pickerBusy.current = false;
      setIsPicking(false);
      reportPickerFailure(
        'google',
        error instanceof Error && error.message === 'GOOGLE_PICKER_CONFIG'
          ? 'configuration'
          : 'open'
      );
      if (error instanceof Error && error.message === 'GOOGLE_PICKER_CONFIG') {
        userToast({
          title: m.source_google_picker_missing_config(),
          variant: 'error',
        });
        return;
      }
      handlePickerError(error);
    }
  }

  async function onGoogleClick() {
    if (
      (!integrations?.google || !integrations.googleDriveReadonly) &&
      !USE_MSW
    ) {
      await connect('google');
      return;
    }
    await openGooglePicker();
  }

  async function openMicrosoftPicker() {
    if (pickerBusy.current) return;
    if (USE_MSW) {
      await inspect('microsoft', [{ id: 'mock_drive_file' }]);
      return;
    }
    const isCurrent = inspectionGuard.begin();
    pickerBusy.current = true;
    setIsPicking(true);
    let pickerWindow: Window | null = null;
    try {
      assertMsalConfigured();
      pickerWindow = window.open('', 'OneDrivePicker', 'width=1080,height=680');
      if (!pickerWindow) throw new Error('POPUP_BLOCKED');
      const drive = await api.get<MicrosoftDriveHost>(
        '/integrations/microsoft/drive'
      );
      if (!isCurrent()) {
        pickerWindow.close();
        return;
      }
      const items = await openOneDrivePicker({
        acquireToken: acquirePickerToken,
        clearAuth: clearPickerAuth,
        drive,
        locale: pickerLocale(getLocale()),
        loginHint: microsoftLoginHint ?? undefined,
        openWindow: () => pickerWindow,
      });
      if (items.length > 0 && isCurrent()) {
        await inspect('microsoft', items, isCurrent);
      }
    } catch (error) {
      if (pickerWindow && !pickerWindow.closed) pickerWindow.close();
      if (!isCurrent()) return;
      if (isPickerUserCancelled(error)) return;
      reportPickerFailure('microsoft', 'open');
      if (isPickerConsentBlocked(error)) {
        userToast({
          description: m.onedrive_picker_blocked_body(),
          title: m.onedrive_picker_blocked_title(),
          variant: 'error',
        });
        return;
      }
      if (error instanceof Error && error.message === 'MSAL_CONFIG') {
        userToast({
          title: m.onedrive_picker_missing_config(),
          variant: 'error',
        });
        return;
      }
      if (error instanceof Error && error.message === 'POPUP_BLOCKED') {
        userToast({
          title: m.onedrive_picker_popup_blocked(),
          variant: 'error',
        });
        return;
      }
      handlePickerError(error);
    } finally {
      if (isCurrent()) {
        pickerBusy.current = false;
        setIsPicking(false);
      }
    }
  }

  if (googlePickerOpen) return null;

  const acceptsDrop = mode === 'upload' && Boolean(uploadPolicy) && canAdd;
  const tabLabel = (label: string, count: number) => (
    <span className="flex items-center gap-1.5">
      {label}
      {count > 0 && (
        <Badge className="-my-1" size="sm" tone="accent-1">
          {count}
        </Badge>
      )}
    </span>
  );

  return (
    <SimpleDialog
      cardScrollContainerClassName="overflow-hidden"
      className="h-[min(680px,88dvh)] max-w-3xl"
      onClose={closeDialog}
      onCloseAutoFocus={(event) => {
        if (googlePicker.current) event.preventDefault();
      }}
      open={open}
      showCloseButton={!isSubmitting}
      title={m.action_add_file()}
    >
      {/* Takes file drops for the Upload tab and keeps a stray drop elsewhere
          in the dialog from opening the file in the tab. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-4"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setIsDragOver(false);
          }
        }}
        onDragOver={(event) => {
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = acceptsDrop ? 'copy' : 'none';
          setIsDragOver(acceptsDrop);
        }}
        onDrop={(event) => {
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          setIsDragOver(false);
          if (acceptsDrop) acceptLocalFiles(event.dataTransfer.files);
        }}
      >
        <Tabs
          onChange={setMode}
          tabs={[
            {
              label: tabLabel(m.action_upload(), uploads.sources.length),
              value: 'upload',
            },
            {
              label: tabLabel(m.action_import(), imports.sources.length),
              value: 'import',
            },
            { label: m.action_create(), value: 'create' },
          ]}
          value={mode}
        />
        <p className="t-meta text-fg-muted">
          {m.source_workspace_file_capacity({
            limit: filesLimit,
            used: filesUsed,
          })}
        </p>
        {mode === 'upload' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {uploads.sources.length === 0 ? (
              <button
                className={cn(
                  'flex flex-col items-center gap-2 rounded-card border-2 border-line border-dashed px-6 py-8 transition-colors hover:bg-surface-hover-bg',
                  isDragOver && 'border-solid-accent-1 bg-tint-accent-1/60'
                )}
                disabled={!uploadPolicy || !canAdd}
                onClick={() => inputRef.current?.click()}
                type="button"
              >
                <Icon className="non-scaling-svg size-7" name="upload" />
                <p className="t-subtitle">{m.source_upload_computer()}</p>
                <p className="t-meta text-fg-muted">{m.source_upload_hint()}</p>
              </button>
            ) : (
              <button
                className={cn(
                  'flex min-h-21.5 shrink-0 items-center justify-center gap-3.5 rounded-card border-2 border-line border-dashed px-5 py-4 text-left transition-colors hover:bg-surface-hover-bg',
                  isDragOver && 'border-solid-accent-1 bg-tint-accent-1/60'
                )}
                disabled={!uploadPolicy || !canAdd}
                onClick={() => inputRef.current?.click()}
                type="button"
              >
                <Icon className="size-6.5 shrink-0" name="upload" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="t-subtitle">
                    {m.source_upload_computer()}
                  </span>
                  <span className="t-meta text-fg-muted">
                    {m.source_upload_hint()}
                  </span>
                </span>
              </button>
            )}
            <input
              accept={uploadPolicy?.accept}
              hidden
              multiple
              onChange={(event) => acceptLocalFiles(event.target.files)}
              ref={inputRef}
              type="file"
            />
            {uploadPolicy && uploads.sources.length > 0 && (
              <SourceList
                batch={uploads}
                disabled={isSubmitting}
                uploadPolicy={uploadPolicy}
                workspaceId={workspaceId}
              />
            )}
          </div>
        )}
        {mode === 'import' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-3">
              <Button
                disabled={isPicking || isInspecting || !canAdd}
                onClick={() => void onGoogleClick()}
                variant="outline"
              >
                <GoogleIcon className="size-5 shrink-0" />
                Google Drive
              </Button>
              <Button
                disabled={isPicking || isInspecting || !canAdd}
                onClick={() => {
                  if (
                    (!integrations?.microsoft ||
                      !integrations.microsoftFilesRead) &&
                    !USE_MSW
                  ) {
                    void connect('microsoft');
                  } else {
                    void openMicrosoftPicker();
                  }
                }}
                variant="outline"
              >
                <OneDriveIcon className="h-4 w-auto shrink-0" />
                OneDrive
              </Button>
            </div>
            {isInspecting && (
              <p className="t-meta mt-3 text-center text-fg-muted">
                {m.source_cloud_inspecting()}
              </p>
            )}
            {!integrations?.google && !integrations?.microsoft && !USE_MSW && (
              <p className="t-meta mt-3 text-center text-fg-muted">
                {m.source_cloud_connect_hint()}
              </p>
            )}
            {uploadPolicy && imports.sources.length > 0 && (
              <SourceList
                batch={imports}
                disabled={isSubmitting}
                uploadPolicy={uploadPolicy}
                workspaceId={workspaceId}
              />
            )}
          </div>
        )}
        {mode === 'create' ? (
          <CreateFilePanel
            onCreated={(item) => {
              onOpenItem?.(item);
              onClose();
            }}
            workspaceId={workspaceId}
          />
        ) : (
          <SourceFooter
            batch={mode === 'import' ? imports : uploads}
            busy={isSubmitting}
            label={mode === 'import' ? m.action_import() : m.action_upload()}
            onSubmit={() =>
              void (mode === 'import'
                ? submit(imports, uploads)
                : submit(uploads, imports))
            }
            uploadPolicy={uploadPolicy}
          />
        )}
      </div>
    </SimpleDialog>
  );
}
