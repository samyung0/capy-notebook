import { captureException } from '@sentry/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { authHeaders, USE_MSW } from '@/api/auth';
import { api } from '@/api/client';
// A typed name has the file name limit, as a rename has it.
import { updateFileBodyNameMax as fileNameMax } from '@/api/gen/validators';
import {
  useChapters,
  useImportSources,
  useInspectSourceImports,
  useIntegrations,
  useRetryFileProcessing,
  useSourceUploadPolicy,
  useUploadSource,
  useWorkspace,
} from '@/api/hooks';
import type {
  FileKind,
  FileLinks,
  InspectSourceImportsResponse,
  MicrosoftDriveHost,
  SourceFile,
  SourceUploadPolicy,
} from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { GoogleIcon, OneDriveIcon } from '@/components/ui/BrandIcons';
import { Button } from '@/components/ui/Button';
import {
  DialogFooter,
  DialogPrimary,
  SimpleDialog,
} from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ProgressBar } from '@/components/ui/ProgressBar';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectValue,
} from '@/components/ui/Select';
import { Separator } from '@/components/ui/Separator';
import { Tabs } from '@/components/ui/Tabs';
import { userToast } from '@/components/ui/userToast';
import type { OpenItem } from '@/features/materials/openItem';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
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
import { audioLengthOrRefuse } from './audioDuration';
import {
  ChapterSelect,
  chapterByName,
  NewChapterInput,
  RowPickerTrigger,
} from './ChapterSelect';
import { CreateFilePanel } from './CreateFilePanel';
import { GenerateFilePanel } from './GenerateFilePanel';
import type { GenerateMode } from './GenerateForm';
import { retryStartedToast } from './retryProcessing';
import { ProviderIcon } from './SourceTransferPanel';
import {
  calculateParseCreditMicros,
  localSourceAnalysisInput,
  SourceAnalysisCancelledError,
  SourceAnalysisError,
  type SourceAnalysisErrorCode,
  type SourceAnalysisInput,
  type SourceAnalysisProgress,
  SourceAnalysisQueue,
  type SourceAnalysisResult,
} from './sourceAnalysis';
import {
  aggregateSourceAnalysis,
  analysisFailurePatch,
  initialAnalysisStatus,
  remoteSourceAnalysisInput,
  type SourceAnalysisStatus,
  sourceAnalysisBlocksSubmit,
  sourceAnalysisIssue,
  sourceAnalysisIssueMessage,
  storedSourceAnalysisInput,
  validateLocalSourceSelection,
} from './sourceDetails';
import { createSourceInspectionGuard } from './sourceInspectionGuard';
import {
  type LocalTransferRequest,
  type RemoteTransferRequest,
  type SourceProvider,
  sourceImportFailureReason,
  startSourceTransfer,
  useSourceTransfers,
} from './sourceTransfers';
import {
  capSourceUploads,
  chunkItems,
  defaultParseMode,
  getFileKind,
  isTextKind,
  MAX_FILES_PER_UPLOAD,
  MAX_FILES_PER_WORKSPACE,
  type ParseMode,
  parseModeIssues,
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

type Provider = SourceProvider;
export interface PendingSource {
  analysisError?: SourceAnalysisErrorCode;
  analysisInput?: SourceAnalysisInput;
  analysisProgress?: SourceAnalysisProgress;
  analysisResult?: SourceAnalysisResult;
  analysisStatus: SourceAnalysisStatus;
  /** Set while the browser reads a local audio file's length. */
  audioDurationPending?: boolean;
  /** The length the browser read. A file it cannot read is refused. */
  audioDurationSeconds?: number;
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
}

function formatSize(bytes: number, estimated = false) {
  const value =
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return estimated ? `~${value}` : value;
}

/** Whether the browser read an audio file as longer than the upload limit. */
function audioTooLong(
  source: Pick<PendingSource, 'audioDurationSeconds'>,
  policy: SourceUploadPolicy
): boolean {
  return (
    source.audioDurationSeconds != null &&
    source.audioDurationSeconds > policy.audioMaxDurationSeconds
  );
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

/** Server limit on files.name, counted in code points like the API. */
function nameTooLong(name: string): boolean {
  return [...name].length > fileNameMax;
}

/** One toast for everything the provider refused in a selection. The
 * picker only returns ids, so it counts files per reason. */
function reportRejectedImports(rejected: { code: string; fileId: string }[]) {
  if (rejected.length === 0) return;
  const counts = new Map<string, number>();
  for (const item of rejected) {
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  }
  userToast({
    description: [...counts]
      .map(([code, count]) =>
        m.source_import_rejected_count({
          count,
          reason: sourceImportFailureReason(code),
        })
      )
      .join('\n'),
    title: m.source_import_failed(),
    variant: 'error',
  });
}

function hasParseModes(pending: PendingSource, policy: SourceUploadPolicy) {
  return pending.kind !== 'unknown' && !isTextKind(pending.kind, policy);
}

function ParseModeSelect({
  pending,
  policy,
  onChange,
}: {
  pending: PendingSource;
  policy: SourceUploadPolicy;
  onChange: (mode: ParseMode) => void;
}) {
  if (!hasParseModes(pending, policy)) return;
  // Images are always captioned (and billed), so "No parsing" would mislead;
  // they upload with parse mode none, the only one the server takes for them.
  if (pending.kind === 'image')
    return (
      <span className="inline-flex h-6.5 translate-y-px items-center px-1.5 font-semibold text-fg-muted text-xs">
        {m.source_fast_parsing()}
      </span>
    );
  const issues = parseModeIssues(
    { name: pending.name, size: pending.sizeBytes },
    pending.kind,
    policy,
    pending.analysisError
  );
  return (
    <Select
      onValueChange={(value) => onChange(value as ParseMode)}
      value={pending.parseMode}
    >
      <RowPickerTrigger>
        <SelectValue />
      </RowPickerTrigger>
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

/** A fast-parse row's analysis failure, refusal or OCR warning, or the
 * notice that a password-protected PDF is added without parsing. */
function SourceAnalysisNote({
  policy,
  source,
}: {
  policy: SourceUploadPolicy;
  source: PendingSource;
}) {
  const issue = sourceAnalysisIssue(source, policy);
  if (!issue) return null;
  return (
    <p
      className={cn('t-meta', {
        'text-fg-muted': issue.code === 'password_protected',
        'text-tint-error-fg':
          issue.code !== 'password_protected' &&
          issue.code !== 'scanned_pages_warning',
        'text-tint-warning-fg': issue.code === 'scanned_pages_warning',
      })}
    >
      {sourceAnalysisIssueMessage(issue, policy)}
    </p>
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

export type AddSourceMode = 'upload' | 'import' | 'create' | 'generate';

/* Connecting a drive sends the whole tab through the provider's consent
 * screen and back, which drops the dialog. The workspace page reopens it on
 * Import from this marker, and Google's in-page picker opens by itself.
 * OneDrive's picker is a popup, so it still needs a click. */
const CONNECT_RESUME_KEY = 'capy:connect-resume';

export function resumedConnect(workspaceId: string): Provider | null {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(CONNECT_RESUME_KEY) ?? 'null'
    ) as { provider: Provider; workspaceId: string } | null;
    return saved?.workspaceId === workspaceId ? saved.provider : null;
  } catch {
    return null;
  }
}

function setConnectResume(
  value: { provider: Provider; workspaceId: string } | null
) {
  try {
    if (value)
      sessionStorage.setItem(CONNECT_RESUME_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(CONNECT_RESUME_KEY);
  } catch {
    /* Storage blocked: the user clicks Import again after the redirect. */
  }
}

/** Expected cost of one source at the policy rates: audio by whole seconds,
 * fast-parsed documents by text-layer and vision-read page count, everything
 * else free. */
function sourceCreditEstimate(
  source: Pick<
    PendingSource,
    'analysisResult' | 'audioDurationSeconds' | 'kind' | 'parseMode'
  >,
  uploadPolicy: SourceUploadPolicy
): number {
  if (source.kind === 'audio') {
    return (
      Math.ceil(source.audioDurationSeconds ?? 0) *
      uploadPolicy.audioSecondCreditMicros
    );
  }
  // An image caption bills its tokens; one text-less page read by the VLM is
  // the closest rate to show for it.
  if (source.kind === 'image') return uploadPolicy.vlmIngestPageCreditMicros;
  if (source.parseMode !== 'fast' || !source.analysisResult) return 0;
  return calculateParseCreditMicros(source.analysisResult, {
    digitalPageRateMicros: uploadPolicy.digitalParsePageCreditMicros,
    vlmPageRateMicros: uploadPolicy.vlmIngestPageCreditMicros,
  });
}

type SourceBatch = ReturnType<typeof useSourceBatch>;

/** One tab's pending sources: analysis and row settings. Upload and Import
 * each own one, so their lists never mix. */
function useSourceBatch(
  uploadPolicy: SourceUploadPolicy | undefined,
  initialSources: PendingSource[]
) {
  const [sources, setSources] = useState(initialSources);
  const queueRef = useRef<SourceAnalysisQueue | null>(null);
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
  // identity: the effect below tears down the queue when it does.
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
        analysisError: undefined,
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
            ...analysisFailurePatch(
              error instanceof SourceAnalysisError ? error.code : 'failed'
            ),
            analysisProgress: undefined,
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
        void audioLengthOrRefuse(source.file).then((duration) =>
          duration == null
            ? setSources((current) =>
                current.filter((item) => item.key !== source.key)
              )
            : patchSource(source.key, {
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
    queueRef.current = queue;
    for (const source of initialRef.current) inspectSource(source);
    return () => {
      queue.dispose();
      if (queueRef.current === queue) queueRef.current = null;
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
    setSources((current) => current.filter((item) => item.key !== source.key));
  }

  /** Empties the list and returns its rows for sending. */
  function take() {
    const taken = sourcesRef.current;
    sourcesRef.current = [];
    setSources([]);
    return taken;
  }

  return {
    add,
    patchSource,
    remove,
    sources,
    take,
    updateParseMode,
  };
}

/** What an audio row says about its length: still reading, over the limit,
 * or its minutes and expected cost. */
function audioDurationNote(
  source: PendingSource,
  policy: SourceUploadPolicy
): string {
  if (source.audioDurationPending || source.audioDurationSeconds == null) {
    return m.source_audio_reading_duration();
  }
  if (audioTooLong(source, policy)) {
    return m.source_audio_too_long({
      hours: policy.audioMaxDurationSeconds / 3600,
    });
  }
  return m.source_audio_estimate({
    cost: (sourceCreditEstimate(source, policy) / 1_000_000).toLocaleString(),
    minutes: Math.ceil(source.audioDurationSeconds / 60),
  });
}

function SourceList({
  batch,
  fixed = false,
  uploadPolicy,
  workspaceId,
}: {
  batch: SourceBatch;
  /** A stored file being retried: its chapter stays and it can't be removed. */
  fixed?: boolean;
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
    batch.patchSource(key, chapterByName(chapters, name));
    setCreatingKey(null);
    setNewChapterName('');
  }

  return (
    <>
      {!fixed && <Separator className="mt-4.5 mb-3" />}
      <div
        className={cn(
          'mb-1.5 flex shrink-0 items-center gap-1.5',
          fixed && 'mt-3'
        )}
      >
        <h3 className="t-card-title">{m.source_selected_files()}</h3>
        <Popover>
          <PopoverTrigger asChild>
            <IconButton
              className="-translate-y-px text-fg-muted"
              icon="info"
              label={m.source_parse_info_label()}
              size="xs"
              variant="ghost-hover"
            />
          </PopoverTrigger>
          <PopoverContent align="start" className="t-meta text-fg-secondary">
            {m.source_parse_hint({
              mb: Math.round(uploadPolicy.maxBytes / 1024 / 1024),
            })}
          </PopoverContent>
        </Popover>
      </div>
      <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto">
        {batch.sources.map((source) => (
          <li className="flex shrink-0 flex-col px-1 py-1.5" key={source.key}>
            <div className="flex items-center gap-2">
              <FileIcon
                className="size-4 shrink-0 -translate-y-px"
                name={fileIconName(source)}
              />
              <span
                // Phones: one step smaller, like the drop zone's heading.
                className="t-body sm:t-subtitle min-w-0 flex-1 truncate font-semibold"
                title={source.name}
              >
                {source.name}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {source.provider && (
                <ProviderIcon
                  className="-translate-y-px text-fg-muted"
                  provider={source.provider}
                />
              )}
              <span className="t-meta text-fg-muted max-sm:text-xs">
                {formatSize(source.sizeBytes, source.sizeEstimate)} ·{' '}
                {source.kind.toUpperCase()}
              </span>
              <div className="ml-auto flex items-center">
                {fixed ? null : creatingKey === source.key ? (
                  <NewChapterInput
                    onCancel={() => setCreatingKey(null)}
                    onChange={setNewChapterName}
                    onConfirm={() => confirmCreateChapter(source.key)}
                    value={newChapterName}
                  />
                ) : (
                  <ChapterSelect
                    chapterName={source.chapterName}
                    chapters={chapters ?? []}
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
                    {!fixed && (
                      <span
                        aria-hidden
                        className="size-0.75 shrink-0 translate-y-px rounded-full bg-fg-muted"
                      />
                    )}
                    <ParseModeSelect
                      onChange={(mode) => batch.updateParseMode(source, mode)}
                      pending={source}
                      policy={uploadPolicy}
                    />
                  </>
                )}
                {!fixed && (
                  <IconButton
                    className="ml-0.5 text-fg-muted"
                    icon="x"
                    label={m.source_remove_file()}
                    onClick={() => batch.remove(source)}
                    size="xs"
                    variant="ghost-hover"
                  />
                )}
              </div>
            </div>
            {/* Every row issue sits here, under the size and settings line. */}
            {nameTooLong(source.name) && (
              <p className="t-meta text-tint-error-fg">
                {m.source_name_too_long({
                  max: fileNameMax,
                })}
              </p>
            )}
            {source.parseMode === 'fast' &&
              (source.analysisStatus === 'error' ||
              source.analysisStatus === 'ready' ? (
                <SourceAnalysisNote policy={uploadPolicy} source={source} />
              ) : (
                source.analysisStatus !== 'idle' && (
                  <div className="mt-1 flex flex-col gap-1">
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
            {source.kind === 'audio' && source.origin === 'local' && (
              <p
                className={cn('t-meta text-fg-muted', {
                  'text-tint-error-fg': audioTooLong(source, uploadPolicy),
                })}
              >
                {audioDurationNote(source, uploadPolicy)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function SourceFooter({
  batch,
  label,
  onSubmit,
  uploadPolicy,
}: {
  batch: SourceBatch;
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
  const images = sources.filter((source) => source.kind === 'image').length;
  const estimatedCreditMicros = uploadPolicy
    ? sources.reduce(
        (total, source) => total + sourceCreditEstimate(source, uploadPolicy),
        0
      )
    : 0;
  const cost = (estimatedCreditMicros / 1_000_000).toLocaleString();
  const { ocrPages: ocr, pages, textPages: text } = analysisTotals;
  const summary =
    pages > 0
      ? images
        ? m.source_analysis_summary_images({ cost, images, ocr, text })
        : m.source_analysis_summary({ cost, ocr, text })
      : images > 0 && m.source_analysis_summary_images_only({ cost, images });
  const blocked =
    !uploadPolicy ||
    sources.some(
      (source) =>
        source.audioDurationPending ||
        audioTooLong(source, uploadPolicy) ||
        sourceAnalysisBlocksSubmit(source, uploadPolicy) ||
        source.analysisStatus === 'error' ||
        nameTooLong(source.name)
    );
  return (
    <DialogFooter className="shrink-0 flex-wrap items-center">
      <div className="t-meta text-fg-muted empty:hidden max-sm:basis-full sm:flex-1">
        {summary}
      </div>
      <DialogPrimary>
        <Button
          disabled={sources.length === 0 || blocked}
          onClick={onSubmit}
          size="lg"
          variant="accent"
        >
          {label}
        </Button>
      </DialogPrimary>
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
  onGeneratingChange,
  resumeProvider,
  retryFile,
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
  /** AI generate runs after the dialog closes; the tree shows it meanwhile. */
  onGeneratingChange?: (mode: GenerateMode | null) => void;
  /** Provider the user just connected through a full-tab redirect. */
  resumeProvider?: Provider | null;
  /** A failed file to process again: the dialog shows only its row, read
   * from the stored bytes, and submits Retry processing. */
  retryFile?: SourceFile;
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
    uploadPolicy,
    initialSources.filter((source) => source.origin === 'local')
  );
  const imports = useSourceBatch(
    uploadPolicy,
    initialSources.filter((source) => source.origin === 'remote')
  );
  const retries = useSourceBatch(uploadPolicy, []);
  const { mutateAsync: retryProcessing } = useRetryFileProcessing(workspaceId);
  const retryRead = useRef<string | null>(null);
  // Mutations keep running after the dialog unmounts, so the transfer
  // runner can hold on to these.
  const { mutateAsync: uploadSource } = useUploadSource(workspaceId);
  const { mutateAsync: importSources } = useImportSources(workspaceId, {
    errorToast: false,
  });
  // Sources still on their way claim workspace room until they are files.
  const inFlightCount = useSourceTransfers(
    (state) =>
      state.transfers.filter(
        (transfer) =>
          transfer.workspaceId === workspaceId &&
          (transfer.stage === 'waiting' ||
            transfer.stage === 'uploading' ||
            transfer.stage === 'importing')
      ).length
  );
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
  const pendingCount =
    uploads.sources.length + imports.sources.length + inFlightCount;
  const canAdd = workspaceRoom > pendingCount;

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
    inspectionGuard.invalidate();
    onClose();
  }

  // The retried file's row, analysed from its stored bytes like an upload.
  useEffect(() => {
    if (!(open && retryFile && uploadPolicy)) return;
    if (retryRead.current === retryFile.id) return;
    retryRead.current = retryFile.id;
    const kind = getFileKind(retryFile.name, uploadPolicy);
    void api
      .get<FileLinks>(`/files/${encodeURIComponent(retryFile.id)}/links`)
      .then(({ url }) => {
        const analysisInput = storedSourceAnalysisInput(
          retryFile,
          url,
          uploadPolicy
        );
        retries.add([
          {
            analysisInput,
            analysisStatus: initialAnalysisStatus(
              retryFile.name,
              analysisInput,
              uploadPolicy
            ),
            chapterId: retryFile.chapterId ?? null,
            chapterName: null,
            contentType: '',
            fileId: retryFile.id,
            key: `retry-${retryFile.id}`,
            kind,
            name: retryFile.name,
            origin: 'remote',
            parseMode: defaultParseMode(
              { name: retryFile.name, size: retryFile.sizeBytes },
              kind,
              uploadPolicy
            ),
            sizeBytes: retryFile.sizeBytes,
            sizeEstimate: false,
          },
        ]);
      })
      .catch(() => {
        retryRead.current = null;
        userToast({ title: m.files_retry_link_failed(), variant: 'error' });
        onClose();
      });
  }, [open, retryFile, uploadPolicy, retries.add, onClose]);

  function submitRetry() {
    const [source] = retries.take();
    if (!(retryFile && source)) return;
    closeDialog();
    void retryProcessing({
      id: retryFile.id,
      parseMode: source.parseMode,
    }).then(retryStartedToast, () => {});
  }

  /** Hands the tab's rows to the transfer panel. The dialog stays open while
   * the other tab still has rows to send. */
  function submit(origin: 'local' | 'remote') {
    if (!uploadPolicy) return;
    const batch = origin === 'local' ? uploads : imports;
    const other = origin === 'local' ? imports : uploads;
    const sources = batch.take();
    if (origin === 'local') {
      startSourceTransfer({
        importSources,
        local: sources.flatMap((source): LocalTransferRequest[] =>
          source.file
            ? [
                {
                  chapterId: source.chapterId,
                  chapterName: source.chapterName,
                  durationSeconds:
                    source.audioDurationSeconds == null
                      ? undefined
                      : Math.ceil(source.audioDurationSeconds),
                  estimatedCreditMicros: sourceCreditEstimate(
                    source,
                    uploadPolicy
                  ),
                  file: source.file,
                  key: source.key,
                  kind: source.kind,
                  name: source.name,
                  pageCount:
                    source.parseMode === 'fast'
                      ? source.analysisResult?.pageCount
                      : undefined,
                  parseMode: source.parseMode,
                },
              ]
            : []
        ),
        uploadSource,
        workspaceId,
      });
    } else {
      startSourceTransfer({
        importSources,
        remote: sources.flatMap((source): RemoteTransferRequest[] =>
          source.fileId && source.provider
            ? [
                {
                  chapterId: source.chapterId,
                  chapterName: source.chapterName,
                  driveId: source.driveId,
                  fileId: source.fileId,
                  key: source.key,
                  kind: source.kind,
                  name: source.name,
                  parseMode: source.parseMode,
                  provider: source.provider,
                },
              ]
            : []
        ),
        uploadSource,
        workspaceId,
      });
    }
    if (other.sources.length === 0) closeDialog();
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
      // Never the raw text: API errors carry status lines and server detail.
      description: errorCopy(error, m.source_try_again()),
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
      setConnectResume({ provider, workspaceId });
      await connectProvider(provider);
    } catch (error) {
      setConnectResume(null);
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
            handlePickerError(new Error('Google Picker error callback'));
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

  const pendingResume = useRef(resumeProvider);
  useEffect(() => {
    setConnectResume(null);
  }, []);
  useEffect(() => {
    if (pendingResume.current !== 'google' || !uploadPolicy || !workspace)
      return;
    if (!integrations?.googleDriveReadonly || !canAdd) return;
    pendingResume.current = null;
    void openGooglePicker();
  }, [canAdd, integrations, uploadPolicy, workspace]);

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

  if (retryFile) {
    return (
      <SimpleDialog
        cardScrollContainerClassName="max-h-[min(680px,88dvh)] overflow-hidden max-sm:pb-[calc(--spacing(4)+max(env(safe-area-inset-bottom),var(--keyboard-inset,0px)))]"
        className="max-w-3xl"
        onClose={closeDialog}
        open={open}
        title={m.files_retry_processing()}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {uploadPolicy && retries.sources.length > 0 ? (
            <SourceList
              batch={retries}
              fixed
              uploadPolicy={uploadPolicy}
              workspaceId={workspaceId}
            />
          ) : (
            <p className="t-meta text-fg-muted">{m.files_retry_loading()}</p>
          )}
          <SourceFooter
            batch={retries}
            label={m.files_retry_processing()}
            onSubmit={submitRetry}
            uploadPolicy={uploadPolicy}
          />
        </div>
      </SimpleDialog>
    );
  }

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
      cardScrollContainerClassName="max-h-[min(680px,88dvh)] overflow-hidden max-sm:pb-[calc(--spacing(4)+max(env(safe-area-inset-bottom),var(--keyboard-inset,0px)))]"
      className="max-w-3xl"
      onClose={closeDialog}
      onCloseAutoFocus={(event) => {
        if (googlePicker.current) event.preventDefault();
      }}
      open={open}
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
          className="dialog-tabs-bleed w-auto"
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
            { label: m.generate_ai(), value: 'generate' },
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
                  'flex flex-col items-center gap-1.5 rounded-card border-2 border-line border-dashed px-6 py-4 transition-colors hover:bg-surface-hover-bg sm:gap-2 sm:py-8',
                  isDragOver && 'border-solid-accent-1 bg-tint-accent-1/60'
                )}
                disabled={!uploadPolicy || !canAdd}
                onClick={() => inputRef.current?.click()}
                type="button"
              >
                <Icon
                  className="non-scaling-svg size-6 sm:size-7"
                  name="upload"
                />
                <p className="t-body font-semibold">
                  {m.source_upload_computer()}
                </p>
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
                  <span className="t-body font-semibold">
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
                uploadPolicy={uploadPolicy}
                workspaceId={workspaceId}
              />
            )}
          </div>
        )}
        {mode === 'generate' ? (
          <GenerateFilePanel
            onClose={onClose}
            onGeneratingChange={onGeneratingChange}
            onOpenItem={onOpenItem}
            workspaceId={workspaceId}
          />
        ) : mode === 'create' ? (
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
            label={mode === 'import' ? m.action_import() : m.action_upload()}
            onSubmit={() => submit(mode === 'import' ? 'remote' : 'local')}
            uploadPolicy={uploadPolicy}
          />
        )}
      </div>
    </SimpleDialog>
  );
}
