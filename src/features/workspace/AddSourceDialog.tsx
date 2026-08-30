import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders, USE_MSW } from '@/api/auth';
import {
  api,
  isCreditsExhaustedError,
  isFileLimitError,
  isStorageQuotaError,
  isTooManyIngestLeasesError,
  qk,
} from '@/api/client';
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
import { Button } from '@/components/ui/Button';
import {
  DialogClose,
  DialogFooter,
  SimpleDialog,
} from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
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
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { userToast } from '@/components/ui/userToast';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { googlePickerEnv } from '@/lib/googlePicker';
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
  supportsFigures,
  withUploadRetry,
} from './sourceUpload';

interface GooglePickerBuilder {
  addView: (view: unknown) => GooglePickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
  setAppId: (id: string) => GooglePickerBuilder;
  setCallback: (
    callback: (data: { action: string; docs?: { id: string }[] }) => void
  ) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
}

declare global {
  interface Window {
    google?: {
      picker: {
        DocsView: new (
          viewId: string
        ) => {
          setIncludeFolders: (include: boolean) => unknown;
        };
        PickerBuilder: new () => GooglePickerBuilder;
        ViewId: { DOCS: string };
      };
    };
  }
}

type Provider = 'google' | 'microsoft';
interface PendingSource {
  analysisInput?: SourceAnalysisInput;
  analysisProgress?: SourceAnalysisProgress;
  analysisResult?: SourceAnalysisResult;
  analysisStatus: SourceAnalysisStatus;
  audioDurationPending?: boolean;
  audioDurationSeconds?: number | null;
  captionImages: boolean;
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

function sourceImportFailureReason(code: string) {
  switch (code) {
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

function loadGooglePicker(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.picker) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      try {
        (
          window as unknown as {
            gapi: { load: (name: string, callback: () => void) => void };
          }
        ).gapi.load('picker', resolve);
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error('failed to load google picker'));
    document.head.appendChild(script);
  });
}

const NO_CHAPTER = '__none__';
const CREATE_CHAPTER = '__create__';

export interface SourceInspectionGuard {
  begin: () => () => boolean;
  invalidate: () => void;
}

export function createSourceInspectionGuard(): SourceInspectionGuard {
  let generation = 0;
  return {
    begin: () => {
      generation += 1;
      const startedAt = generation;
      return () => generation === startedAt;
    },
    invalidate: () => {
      generation += 1;
    },
  };
}

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
      <SelectTrigger className="w-fit" size="sm" variant="underline">
        <div className="w-fit min-w-28 max-w-36">
          {chapterName ? (
            <span className="line-clamp-1 translate-y-px">{chapterName}</span>
          ) : (
            <SelectValue />
          )}
        </div>
      </SelectTrigger>
      <SelectContent className="max-w-47">
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
            <SelectGroup>
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
  if (pending.kind === 'unknown' || isTextKind(pending.kind, policy)) return;
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
      <SelectTrigger className="w-fit" size="sm" variant="underline">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
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

export function CaptionImagesToggle({
  pending,
  policy,
  onChange,
  disabled = false,
}: {
  pending: PendingSource;
  policy: SourceUploadPolicy;
  onChange: (captionImages: boolean) => void;
  disabled?: boolean;
}) {
  if (!supportsFigures(pending.parseMode, pending.kind, policy)) return;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Switch
        aria-label={m.source_describe_images_file({ name: pending.name })}
        checked={pending.captionImages}
        disabled={disabled}
        onCheckedChange={onChange}
        size="sm"
      />
      <span className="t-meta text-fg-muted">{m.source_describe_images()}</span>
    </div>
  );
}

function localRows(
  selections: ReturnType<typeof validateLocalSourceSelection>['accepted'],
  policy: SourceUploadPolicy
): PendingSource[] {
  const now = Date.now();
  return selections.map(({ file, kind }, index) => {
    const key = `local-${now}-${index}-${file.name}`;
    const input = localSourceAnalysisInput(file);
    return {
      analysisInput: input
        ? { ...input, key: `${key}\0${input.key}` }
        : undefined,
      analysisStatus: 'idle',
      audioDurationPending: kind === 'audio',
      captionImages: false,
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

function SourceChooser({
  open,
  onClose,
  onSelected,
  inspectionGuard,
  workspaceId,
  workspaceRoom,
  filesLimit,
  filesUsed,
  uploadPolicy,
}: {
  open: boolean;
  onClose: () => void;
  onSelected: (sources: PendingSource[]) => void;
  inspectionGuard: SourceInspectionGuard;
  workspaceId: string;
  workspaceRoom: number;
  filesLimit: number;
  filesUsed: number;
  uploadPolicy?: SourceUploadPolicy;
}) {
  const [mode, setMode] = useState('upload');
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: integrations } = useIntegrations({ errorBoundary: false });
  const { mutateAsync: inspectSources, isPending: isInspecting } =
    useInspectSourceImports(workspaceId, { errorToast: false });
  const connectProvider = useProviderConnect();
  const microsoftLoginHint = useMicrosoftLoginHint();

  useEffect(() => {
    if (!open) inspectionGuard.invalidate();
  }, [inspectionGuard, open]);

  useEffect(() => () => inspectionGuard.invalidate(), [inspectionGuard]);

  function closeChooser() {
    inspectionGuard.invalidate();
    onClose();
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
    const capped = capSourceUploads(0, selected.accepted, workspaceRoom);
    if (capped.rejected > 0) workspaceRoomToast(workspaceRoom, filesLimit);
    if (capped.accepted.length > 0) {
      onSelected(localRows(capped.accepted, uploadPolicy));
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
    const capped = capSourceUploads(0, refs, workspaceRoom);
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
      if (inspection.items.length === 0) return;
      const headers = await authHeaders();
      if (!isCurrent()) return;
      const rows: PendingSource[] = inspection.items.map((item) => {
        const kind = getFileKind(item.name, uploadPolicy);
        return {
          analysisInput: remoteSourceAnalysisInput(
            item,
            provider,
            headers,
            inspectionKey
          ),
          analysisStatus: 'idle',
          captionImages: false,
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
      onSelected(rows);
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
    if (USE_MSW) {
      await inspect('google', [{ id: 'mock_drive_file' }]);
      return;
    }
    const isCurrent = inspectionGuard.begin();
    try {
      const { apiKey, appId } = googlePickerEnv();
      const { accessToken } = await api.get<{ accessToken: string }>(
        '/integrations/google/picker-token'
      );
      await loadGooglePicker();
      if (!isCurrent()) return;
      const google = window.google?.picker;
      if (!google) throw new Error('Google Picker did not finish loading.');
      const view = new google.DocsView(google.ViewId.DOCS);
      view.setIncludeFolders(true);
      const picker = new google.PickerBuilder()
        .addView(view)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .setOAuthToken(accessToken)
        .setCallback((data) => {
          if (!isCurrent() || data.action !== 'picked' || !data.docs?.length)
            return;
          void inspect(
            'google',
            data.docs.map((document) => ({ id: document.id })),
            isCurrent
          );
        })
        .build();
      picker.setVisible(true);
    } catch (error) {
      if (!isCurrent()) return;
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
    if (!integrations?.google && !USE_MSW) {
      await connect('google');
      return;
    }
    await openGooglePicker();
  }

  async function openMicrosoftPicker() {
    if (USE_MSW) {
      await inspect('microsoft', [{ id: 'mock_drive_file' }]);
      return;
    }
    const isCurrent = inspectionGuard.begin();
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
    }
  }

  return (
    <SimpleDialog
      className="min-h-150 max-w-3xl"
      onClose={closeChooser}
      open={open}
      title={m.action_add_file()}
    >
      <div className="flex h-full flex-col gap-4">
        <Tabs
          onChange={setMode}
          tabs={[
            { label: m.action_upload(), value: 'upload' },
            { label: m.action_import(), value: 'import' },
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
          <div className="flex flex-1 flex-col gap-4">
            <button
              className="flex flex-col items-center gap-2 rounded-card border-2 border-line border-dashed px-6 py-8 transition-colors hover:bg-surface-hover-bg"
              disabled={!uploadPolicy || workspaceRoom <= 0}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              <Icon className="size-7" name="upload" />
              <p className="t-subtitle">{m.source_upload_computer()}</p>
              <p className="t-meta text-fg-muted">{m.source_upload_hint()}</p>
            </button>
            <input
              accept={uploadPolicy?.accept}
              hidden
              multiple
              onChange={(event) => acceptLocalFiles(event.target.files)}
              ref={inputRef}
              type="file"
            />
          </div>
        )}
        {mode === 'import' && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Button
                disabled={isInspecting || workspaceRoom <= 0}
                iconLeft="files"
                onClick={() => void onGoogleClick()}
                variant="outline"
              >
                Google Drive
              </Button>
              <Button
                disabled={isInspecting || workspaceRoom <= 0}
                iconLeft="files"
                onClick={() => {
                  if (!integrations?.microsoft && !USE_MSW) {
                    void connect('microsoft');
                  } else {
                    void openMicrosoftPicker();
                  }
                }}
                variant="outline"
              >
                OneDrive
              </Button>
            </div>
            {isInspecting && (
              <p className="t-meta text-center text-fg-muted">
                {m.source_cloud_inspecting()}
              </p>
            )}
            {!integrations?.google && !integrations?.microsoft && !USE_MSW && (
              <p className="t-meta text-center text-fg-muted">
                {m.source_cloud_connect_hint()}
              </p>
            )}
          </div>
        )}
        {mode === 'create' && <div>dummy</div>}
      </div>
    </SimpleDialog>
  );
}

function SourceDetailsDialog({
  initialSources,
  onClose,
  onEmpty,
  open,
  uploadPolicy,
  workspaceId,
}: {
  initialSources: PendingSource[];
  onClose: () => void;
  onEmpty: () => void;
  open: boolean;
  uploadPolicy: SourceUploadPolicy;
  workspaceId: string;
}) {
  const { mutateAsync: uploadSource } = useUploadSource(workspaceId);
  const { mutateAsync: importSources } = useImportSources(workspaceId, {
    errorToast: false,
  });
  const { data: ingestSlots, refetch: refetchIngestSlots } = useIngestSlots({
    errorBoundary: false,
  });
  const { data: chapters } = useChapters(workspaceId, {
    errorBoundary: false,
  });
  const queryClient = useQueryClient();
  const [sources, setSources] = useState(initialSources);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [newChapterName, setNewChapterName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [unsentCount, setUnsentCount] = useState(0);
  const queueRef = useRef<SourceAnalysisQueue | null>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const drainAbort = useRef(new AbortController());
  const importRequestIds = useRef(new Map<string, string>());
  useUnsentBeforeUnload(unsentCount);

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

  const enqueueAnalysis = useCallback(
    (source: PendingSource) => {
      if (!source.analysisInput || source.parseMode !== 'fast') return;
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

  useEffect(() => {
    const queue = new SourceAnalysisQueue();
    const drainController = new AbortController();
    queueRef.current = queue;
    drainAbort.current = drainController;
    for (const source of initialSources) {
      enqueueAnalysis(source);
      if (source.kind === 'audio' && source.file) {
        void readAudioDuration(source.file).then((duration) =>
          patchSource(source.key, {
            audioDurationPending: false,
            audioDurationSeconds: duration,
          })
        );
      }
    }
    return () => {
      queue.dispose();
      if (queueRef.current === queue) queueRef.current = null;
      drainAbort.current.abort();
      drainController.abort();
      for (const controller of uploadControllers.current.values()) {
        controller.abort();
      }
    };
  }, [enqueueAnalysis, initialSources]);

  function updateParseMode(source: PendingSource, parseMode: ParseMode) {
    if (parseMode === 'none') {
      queueRef.current?.cancel(source.key);
      patchSource(source.key, {
        analysisProgress: undefined,
        analysisStatus: source.analysisResult ? 'ready' : 'idle',
        captionImages: false,
        parseMode,
      });
      return;
    }
    const next = { ...source, parseMode };
    patchSource(source.key, { parseMode });
    enqueueAnalysis(next);
  }

  function removeSource(source: PendingSource) {
    queueRef.current?.cancel(source.key);
    uploadControllers.current.get(source.key)?.abort();
    if (sources.length === 1) {
      onEmpty();
      return;
    }
    setSources((current) => current.filter((item) => item.key !== source.key));
  }

  function confirmCreateChapter(key: string) {
    const name = newChapterName.trim();
    if (!name) return;
    const existing = chapters?.find(
      (chapter) => chapter.name.toLowerCase() === name.toLowerCase()
    );
    patchSource(key, {
      chapterId: existing?.id ?? null,
      chapterName: existing ? null : name,
    });
    setCreatingKey(null);
    setNewChapterName('');
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

  async function submitLocal(localSources: PendingSource[]) {
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
              captionImages: source.captionImages,
              chapterId: source.chapterId,
              chapterName: source.chapterName,
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
          source.captionImages,
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
                  captionImages: source.captionImages,
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

  async function handleSubmit() {
    if (isSubmitting || sources.length === 0) return;
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
        sources.filter((source) => source.origin === 'local')
      );
      const remoteFailed = await submitRemote(
        sources.filter((source) => source.origin === 'remote')
      );
      if (controller.signal.aborted) return;
      const failed = [...localFailed, ...remoteFailed];
      if (failed.length > 0) {
        setSources([
          ...new Map(failed.map((source) => [source.key, source])).values(),
        ]);
      } else onClose();
    } finally {
      if (!controller.signal.aborted) {
        setIsSubmitting(false);
        setUnsentCount(0);
      }
    }
  }

  const analysisTotals = aggregateSourceAnalysis(
    sources
      .filter((source) => source.parseMode === 'fast')
      .map((source) => source.analysisResult)
  );
  const estimatedCreditMicros = sources.reduce((total, source) => {
    if (source.kind === 'audio' && source.audioDurationSeconds != null) {
      return (
        total +
        Math.ceil(source.audioDurationSeconds) *
          uploadPolicy.audioSecondCreditMicros
      );
    }
    if (source.parseMode !== 'fast' || !source.analysisResult) return total;
    return (
      total +
      calculateParseCreditMicros(source.analysisResult, {
        digitalPageRateMicros: uploadPolicy.digitalParsePageCreditMicros,
        ocrPageRateMicros: uploadPolicy.ocrParsePageCreditMicros,
      })
    );
  }, 0);
  const waitingForAnalysis = sources.some(
    (source) =>
      source.audioDurationPending ||
      (source.audioDurationSeconds != null &&
        source.audioDurationSeconds > uploadPolicy.audioMaxDurationSeconds) ||
      sourceAnalysisBlocksSubmit(source, uploadPolicy)
  );
  const aggregateProgress = aggregateUploadPct(
    sources
      .filter((source) => source.origin === 'local')
      .map((source) => ({
        size: source.sizeBytes,
        uploadPct: source.uploadPct,
      }))
  );
  const parseMaxMb = Math.round(uploadPolicy.maxBytes / 1024 / 1024);

  return (
    <SimpleDialog
      className="min-h-150 max-w-3xl"
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      open={open}
      showCloseButton={!isSubmitting}
      title={m.source_selected_files()}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <ul className="flex max-h-[54dvh] flex-col gap-3 overflow-y-auto pr-1">
          {sources.map((source) => (
            <li
              className="flex flex-col gap-2 rounded-card border border-line px-3 py-2.5"
              key={source.key}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="size-4 shrink-0" name="files" />
                  <span className="t-subtitle truncate" title={source.name}>
                    {source.name}
                  </span>
                </div>
                <IconButton
                  disabled={isSubmitting}
                  icon="x"
                  label={m.source_remove_file()}
                  onClick={() => removeSource(source)}
                  size="xs"
                  variant="ghost-hover"
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="t-meta text-fg-muted">
                  {formatSize(source.sizeBytes, source.sizeEstimate)} ·{' '}
                  {source.kind.toUpperCase()}
                </span>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {creatingKey === source.key ? (
                    <div className="flex items-center">
                      <Input
                        autoFocus
                        disabled={isSubmitting}
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
                        disabled={isSubmitting || !newChapterName.trim()}
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
                      disabled={isSubmitting}
                      onChange={(chapterId) =>
                        patchSource(source.key, {
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
                  <ParseModeSelect
                    disabled={isSubmitting}
                    onChange={(mode) => updateParseMode(source, mode)}
                    pending={source}
                    policy={uploadPolicy}
                  />
                  <CaptionImagesToggle
                    disabled={isSubmitting}
                    onChange={(captionImages) =>
                      patchSource(source.key, { captionImages })
                    }
                    pending={source}
                    policy={uploadPolicy}
                  />
                </div>
              </div>
              {source.parseMode === 'fast' &&
                source.analysisStatus !== 'idle' && (
                  <div className="flex flex-col gap-1">
                    {source.analysisStatus !== 'ready' &&
                      source.analysisStatus !== 'error' && (
                        <ProgressBar
                          height={4}
                          value={source.analysisProgress?.percent ?? 0}
                        />
                      )}
                    <p
                      className={cn('t-meta text-fg-muted', {
                        'text-tint-error-fg': source.analysisStatus === 'error',
                      })}
                    >
                      {source.analysisStatus === 'ready' &&
                        source.analysisResult &&
                        m.source_analysis_result({
                          ocr: source.analysisResult.ocrPageCount,
                          text: source.analysisResult.textPageCount,
                        })}
                      {source.analysisStatus === 'error' &&
                        m.source_analysis_failed()}
                      {source.analysisStatus !== 'ready' &&
                        source.analysisStatus !== 'error' &&
                        m.source_analyzing_progress({
                          percent: Math.round(
                            source.analysisProgress?.percent ?? 0
                          ),
                        })}
                    </p>
                  </div>
                )}
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
                            minutes: Math.ceil(
                              source.audioDurationSeconds / 60
                            ),
                          })}
                </p>
              )}
              {source.uploadPct != null && (
                <ProgressBar height={4} value={source.uploadPct} />
              )}
            </li>
          ))}
        </ul>
        <p className="t-meta text-fg-muted">
          {m.source_parse_hint({ mb: parseMaxMb })}
        </p>
        {isSubmitting && <ProgressBar showLabel value={aggregateProgress} />}
      </div>
      <DialogFooter className="items-center sm:justify-between">
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
            <Button disabled={isSubmitting} size="lg" variant="ghost-hover">
              {m.action_cancel()}
            </Button>
          </DialogClose>
          <Button
            disabled={
              sources.length === 0 ||
              isSubmitting ||
              waitingForAnalysis ||
              sources.some((source) => source.analysisStatus === 'error')
            }
            onClick={() => void handleSubmit()}
            size="lg"
          >
            {sources.every((source) => source.origin === 'remote')
              ? m.action_import()
              : m.action_upload()}
          </Button>
        </div>
      </DialogFooter>
    </SimpleDialog>
  );
}

export function AddSourceDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const { data: uploadPolicy } = useSourceUploadPolicy(workspaceId, {
    errorBoundary: false,
  });
  const [selectedSources, setSelectedSources] = useState<PendingSource[]>([]);
  const [inspectionGuard] = useState(createSourceInspectionGuard);
  const { filesLimit, filesUsed, workspaceRoom } = workspaceFileRoom(workspace);

  function closeAll() {
    inspectionGuard.invalidate();
    setSelectedSources([]);
    onClose();
  }

  return (
    <>
      {selectedSources.length === 0 && (
        <SourceChooser
          filesLimit={filesLimit}
          filesUsed={filesUsed}
          inspectionGuard={inspectionGuard}
          onClose={closeAll}
          onSelected={setSelectedSources}
          open={open}
          uploadPolicy={uploadPolicy}
          workspaceId={workspaceId}
          workspaceRoom={workspaceRoom}
        />
      )}
      {uploadPolicy && selectedSources.length > 0 && (
        <SourceDetailsDialog
          initialSources={selectedSources}
          onClose={closeAll}
          onEmpty={() => setSelectedSources([])}
          open={open}
          uploadPolicy={uploadPolicy}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}
