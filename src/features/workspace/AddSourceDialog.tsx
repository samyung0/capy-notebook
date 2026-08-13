import { useEffect, useRef, useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { api, isStorageQuotaError } from '@/api/client';
import {
  useChapters,
  useImportSources,
  useIntegrations,
  useSourceUploadPolicy,
  useUploadSource,
} from '@/api/hooks';
import type { Chapter, SourceFile, SourceUploadPolicy } from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  ConfirmDialog,
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
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useProviderConnect } from '@/lib/useProviderConnect';
import { OneDriveImportDialog } from './OneDriveImportDialog';
import {
  aggregateUploadPct,
  defaultParseMode,
  fileExt,
  getFileKind,
  isTextKind,
  type ParseMode,
  parseModeIssues,
  supportsFigures,
} from './sourceUpload';

/** Count a PDF's pages with pdfjs (already bundled via react-pdf, loaded on
 * demand). Returns null for non-PDFs and unreadable/encrypted files. */
async function pdfPageCount(file: File): Promise<number | null> {
  if (fileExt(file.name) !== 'pdf') return null;
  try {
    const { pdfjs } = await import('react-pdf');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
    }
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() })
      .promise;
    const n = doc.numPages;
    void doc.destroy();
    return n;
  } catch {
    return null;
  }
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface GooglePickerBuilder {
  addView: (v: unknown) => GooglePickerBuilder;
  build: () => { setVisible: (v: boolean) => void };
  setCallback: (
    cb: (data: { action: string; docs?: { id: string }[] }) => void
  ) => GooglePickerBuilder;
  setOAuthToken: (t: string) => GooglePickerBuilder;
}

declare global {
  interface Window {
    google?: {
      picker: {
        ViewId: { DOCS: string };
        DocsView: new (
          viewId: string
        ) => {
          setIncludeFolders: (v: boolean) => unknown;
        };
        PickerBuilder: new () => GooglePickerBuilder;
      };
    };
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
            gapi: { load: (n: string, cb: () => void) => void };
          }
        ).gapi.load('picker', () => resolve());
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

function ChapterSelect({
  chapters,
  value,
  chapterName,
  onChange,
  onCreateRequest,
}: {
  chapters: Chapter[];
  value: string | null;
  chapterName?: string | null;
  onChange: (v: string | null) => void;
  onCreateRequest?: () => void;
}) {
  return (
    <Select
      onValueChange={(v) => {
        if (v === CREATE_CHAPTER) {
          onCreateRequest?.();
          return;
        }
        onChange(v === NO_CHAPTER ? null : v);
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
          {chapters.map((o) => (
            <SelectItem key={o.id} size="sm" value={o.id}>
              <span className="line-clamp-1 translate-y-px">{o.name}</span>
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

interface PendingFile {
  captionImages: boolean;
  chapterId: string | null;
  chapterName: string | null;
  file: File;
  key: string;
  kind: SourceFile['kind'];
  /** PDF page count via pdfjs; undefined = still counting, null = unknown. */
  pageCount?: number | null;
  parseMode: ParseMode;
  uploadPct?: number;
}

function ParseModeSelect({
  pending,
  policy,
  onChange,
}: {
  pending: PendingFile;
  policy: SourceUploadPolicy;
  onChange: (mode: ParseMode) => void;
}) {
  if (pending.kind === 'unknown') return;
  if (isTextKind(pending.kind, policy)) return;
  const issues = parseModeIssues(
    pending.file,
    pending.kind,
    policy,
    pending.pageCount
  );
  if (issues.accurate && issues.fast) return;
  return (
    <Select
      onValueChange={(v) => onChange(v as ParseMode)}
      value={pending.parseMode}
    >
      <SelectTrigger className="w-fit" size="sm" variant="underline">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem disabled={!!issues.accurate} size="sm" value="accurate">
            {m.source_accurate_parsing()}
            {issues.accurate ? ` (${issues.accurate})` : ''}
          </SelectItem>
          <SelectItem disabled={!!issues.fast} size="sm" value="fast">
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

function CaptionImagesToggle({
  pending,
  policy,
  onChange,
}: {
  pending: PendingFile;
  policy: SourceUploadPolicy;
  onChange: (captionImages: boolean) => void;
}) {
  if (!supportsFigures(pending.parseMode, pending.kind, policy)) return;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Switch
        aria-label={m.source_describe_images_file({ name: pending.file.name })}
        checked={pending.captionImages}
        onCheckedChange={onChange}
        size="sm"
      />
      <span className="t-meta text-fg-muted">{m.source_describe_images()}</span>
    </div>
  );
}

function UploadFiles({
  workspaceId,
  onClose,
  className,
}: {
  workspaceId: string;
  onClose?: () => void;
  className?: string;
}) {
  const { mutateAsync: uploadSource } = useUploadSource(workspaceId);
  const { data: uploadPolicy } = useSourceUploadPolicy(workspaceId, {
    errorBoundary: false,
  });
  const { data: chapters } = useChapters(workspaceId, {
    errorBoundary: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  // Row currently typing a new chapter name (replaces its chapter select).
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [newChapterName, setNewChapterName] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(
    () => () => {
      for (const controller of uploadControllers.current.values())
        controller.abort();
    },
    []
  );

  function handleFiles(list: FileList | null) {
    if (!list?.length) return;
    if (!uploadPolicy) {
      userToast({
        description: m.source_formats_loading_body(),
        title: m.source_formats_loading_title(),
        variant: 'error',
      });
      return;
    }
    const candidates = Array.from(list).map((f, i) => {
      const kind = getFileKind(f.name, uploadPolicy);
      return {
        captionImages: false,
        chapterId: null,
        chapterName: null,
        file: f,
        key: `${Date.now()}-${i}-${f.name}`,
        kind,
        parseMode: defaultParseMode(f, kind, uploadPolicy),
      };
    });
    const added = candidates.filter((file) => file.kind !== 'unknown');
    const rejected = candidates.filter((file) => file.kind === 'unknown');
    if (rejected.length) {
      userToast({
        description: rejected.map((file) => file.file.name).join(', '),
        title: m.source_unsupported_format(),
        variant: 'error',
      });
    }
    if (!added.length) {
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setFiles((prev) => [...prev, ...added]);
    if (inputRef.current) inputRef.current.value = '';
    // Count PDF pages in the background; if the count invalidates the row's
    // current mode, fall back to the best valid one.
    for (const row of added) {
      if (fileExt(row.file.name) !== 'pdf') continue;
      void pdfPageCount(row.file).then((n) => {
        setFiles((prev) =>
          prev.map((f) => {
            if (f.key !== row.key) return f;
            const next: PendingFile = { ...f, pageCount: n };
            if (
              f.parseMode !== 'none' &&
              parseModeIssues(f.file, f.kind, uploadPolicy, n)[f.parseMode]
            ) {
              next.parseMode = defaultParseMode(
                f.file,
                f.kind,
                uploadPolicy,
                n
              );
            }
            return next;
          })
        );
      });
    }
  }

  function patchFile(key: string, patch: Partial<PendingFile>) {
    setFiles((prev) =>
      prev.map((f) => (f.key === key ? { ...f, ...patch } : f))
    );
  }

  function confirmCreateChapter(key: string) {
    const name = newChapterName.trim();
    if (!name) return;
    // Reuse an existing chapter when it is already loaded. New names travel
    // with the upload and are resolved atomically by the backend.
    const existing = chapters?.find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );
    patchFile(key, {
      chapterId: existing?.id ?? null,
      chapterName: existing ? null : name,
    });
    setCreatingKey(null);
    setNewChapterName('');
  }

  const handleUpload = async () => {
    if (isSubmitting || files.length === 0) return;
    setIsSubmitting(true);
    const batch = [...files];
    setFiles((prev) => prev.map((file) => ({ ...file, uploadPct: 0 })));
    const results = await Promise.allSettled(
      batch.map((f) => {
        const controller = new AbortController();
        uploadControllers.current.set(f.key, controller);
        return uploadSource({
          captionImages: f.captionImages,
          chapterId: f.chapterId,
          chapterName: f.chapterName,
          file: f.file,
          kind: f.kind,
          onUploadProgress: (uploadPct) => patchFile(f.key, { uploadPct }),
          parseMode: f.parseMode,
          signal: controller.signal,
        }).finally(() => uploadControllers.current.delete(f.key));
      })
    );
    setIsSubmitting(false);
    if (results.every((r) => r.status === 'fulfilled')) {
      setFiles([]);
      setConfirmOpen(false);
      onClose?.();
    } else {
      const succeededKeys = new Set(
        batch
          .filter((_, index) => results[index]?.status === 'fulfilled')
          .map((file) => file.key)
      );
      setFiles((prev) => prev.filter((file) => !succeededKeys.has(file.key)));
      const quotaFailure = results.find(
        (result) =>
          result.status === 'rejected' && isStorageQuotaError(result.reason)
      );
      userToast({
        description: quotaFailure ? m.error_quota_body() : undefined,
        title: quotaFailure ? m.error_quota_title() : m.source_upload_failed(),
        variant: 'error',
      });
    }
  };
  const formatFileSizes = () => {
    const totalBytes = files.reduce((acc, file) => acc + file.file.size, 0);
    if (totalBytes < 1024) return `${totalBytes} bytes`;
    if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
    return `${(totalBytes / 1024 / 1024).toFixed(1)} MB`;
  };
  const parseMaxMb = Math.round(
    (uploadPolicy?.maxBytes ?? 10 * 1024 * 1024) / 1024 / 1024
  );
  const aggregateProgress = aggregateUploadPct(
    files.map((file) => ({ size: file.file.size, uploadPct: file.uploadPct }))
  );
  const completedUploads = files.filter(
    (file) => file.uploadPct === 100
  ).length;

  return (
    <div
      className={cn('flex h-full flex-col justify-between gap-4', className)}
    >
      <div className="flex flex-col gap-4">
        <button
          className={cn(
            'flex flex-col items-center gap-2 rounded-card border-2 border-line border-dashed px-6 py-8 transition-colors hover:bg-surface-hover-bg',
            files.length > 0 && 'py-4'
          )}
          disabled={!uploadPolicy}
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
          onChange={(e) => handleFiles(e.target.files)}
          ref={inputRef}
          type="file"
        />

        {files.length > 0 && (
          <ul className="flex max-h-88 flex-col gap-2 overflow-y-auto pr-1">
            {files.map((f) => (
              <li className="flex flex-col gap-2 px-1.5 pt-0.5" key={f.key}>
                <div className="flex flex-col gap-0">
                  <div className="flex flex-1 justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Icon
                        className="size-4 shrink-0 -translate-y-px"
                        name="files"
                      />
                      <span
                        className="t-subtitle min-w-0 flex-1 truncate"
                        title={f.file.name}
                      >
                        {f.file.name}
                      </span>
                    </div>
                    <IconButton
                      icon="x"
                      label={m.source_remove_file()}
                      onClick={() => {
                        uploadControllers.current.get(f.key)?.abort();
                        setFiles((prev) =>
                          prev.filter((pf) => pf.key !== f.key)
                        );
                      }}
                      size="xs"
                      variant="ghost-hover"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="t-meta shrink-0 text-fg-muted">
                      {formatSize(f.file.size)}
                      {f.pageCount != null &&
                        ` · ${f.pageCount === 1 ? m.source_page({ count: f.pageCount }) : m.source_pages({ count: f.pageCount })}`}
                      {` · ${f.kind.toUpperCase()}`}
                    </span>
                    <div className="flex flex-1 items-center justify-end gap-2">
                      <div className="min-w-0">
                        {creatingKey === f.key ? (
                          <div className="flex items-center gap-0">
                            <Input
                              autoFocus
                              onChange={(e) =>
                                setNewChapterName(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter')
                                  void confirmCreateChapter(f.key);
                                if (e.key === 'Escape') setCreatingKey(null);
                              }}
                              placeholder={m.source_new_chapter_name()}
                              size="sm"
                              value={newChapterName}
                              variant="underline"
                            />
                            <IconButton
                              className="p-1.5"
                              disabled={!newChapterName.trim()}
                              icon="check"
                              label={m.source_create_chapter()}
                              onClick={() => void confirmCreateChapter(f.key)}
                              size="xs"
                              variant="ghost-hover"
                            />
                            <IconButton
                              className="p-1.5"
                              icon="x"
                              label={m.action_cancel()}
                              onClick={() => setCreatingKey(null)}
                              size="xs"
                              variant="ghost-hover"
                            />
                          </div>
                        ) : (
                          <ChapterSelect
                            chapterName={f.chapterName}
                            chapters={chapters ?? []}
                            onChange={(v) =>
                              patchFile(f.key, {
                                chapterId: v,
                                chapterName: null,
                              })
                            }
                            onCreateRequest={() => {
                              setCreatingKey(f.key);
                              setNewChapterName('');
                            }}
                            value={f.chapterId}
                          />
                        )}
                      </div>
                      <div className="min-w-0">
                        {uploadPolicy && (
                          <ParseModeSelect
                            onChange={(mode) =>
                              patchFile(f.key, {
                                captionImages:
                                  mode === 'none' ? false : f.captionImages,
                                parseMode: mode,
                              })
                            }
                            pending={f}
                            policy={uploadPolicy}
                          />
                        )}
                      </div>
                      {uploadPolicy && (
                        <CaptionImagesToggle
                          onChange={(captionImages) =>
                            patchFile(f.key, { captionImages })
                          }
                          pending={f}
                          policy={uploadPolicy}
                        />
                      )}
                    </div>
                  </div>
                  {f.uploadPct != null && (
                    <ProgressBar
                      className="mt-1.5 w-full"
                      height={4}
                      value={f.uploadPct}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="t-meta pt-3 text-fg-muted">
          {m.source_parse_hint({ mb: parseMaxMb })}
        </p>
      </div>
      <ConfirmDialog
        body={m.source_confirm_body({
          count: files.length,
          size: formatFileSizes(),
        })}
        closeOnConfirm={false}
        danger={false}
        disabled={!uploadPolicy || files.length === 0 || isSubmitting}
        isSubmitting={isSubmitting}
        onClose={() => {
          if (!isSubmitting) setConfirmOpen(false);
        }}
        onConfirm={handleUpload}
        open={confirmOpen}
        title={m.source_confirm_upload()}
      >
        {isSubmitting && (
          <div className="mt-3 flex flex-col gap-1.5">
            <ProgressBar showLabel value={aggregateProgress} />
            <p className="t-meta text-fg-muted">
              {m.source_uploading({
                done: completedUploads,
                total: files.length,
              })}
            </p>
          </div>
        )}
      </ConfirmDialog>
      <DialogFooter>
        <DialogClose asChild>
          <Button
            disabled={isSubmitting}
            onClick={onClose}
            size="lg"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
        </DialogClose>
        <Button
          disabled={!uploadPolicy || files.length === 0 || isSubmitting}
          onClick={() => setConfirmOpen(true)}
          size="lg"
        >
          <span>{m.action_upload()}</span>
          {/* <span>
            <Spinner />
          </span> */}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ImportFiles({
  workspaceId,
  onClose,
  className,
}: {
  workspaceId: string;
  onClose: () => void;
  className?: string;
}) {
  // const [chapterId, setChapterId] = useState<string | null>(null);
  const [msOpen, setMsOpen] = useState(false);
  const { data: integrations } = useIntegrations({ errorBoundary: false });
  const { isPending: importSourcesIsPending, mutate: importSources } =
    useImportSources(workspaceId, { errorToast: false });
  // const { data: msFiles } = useMicrosoftRecentFiles(msOpen && !!integrations?.microsoft);

  const connectProvider = useProviderConnect();

  function handleImportError(error: unknown) {
    userToast({
      description: isStorageQuotaError(error)
        ? m.error_quota_body()
        : error instanceof Error
          ? error.message
          : m.source_try_again(),
      title: isStorageQuotaError(error)
        ? m.error_quota_title()
        : m.source_import_failed(),
      variant: 'error',
    });
  }

  async function connect(provider: 'google' | 'microsoft') {
    if (USE_MSW) {
      importSources(
        {
          chapterId: null,
          fileIds: ['mock_drive_file'],
          provider,
        },
        { onError: handleImportError }
      );
      onClose();
      return;
    }
    try {
      // Clerk links the external account, then redirects to the provider's
      // consent screen and back here.
      await connectProvider(provider);
    } catch (err) {
      userToast({
        description: err instanceof Error ? err.message : m.source_try_again(),
        title: m.source_connect_failed({ provider }),
        variant: 'error',
      });
    }
  }

  async function openGooglePicker() {
    if (USE_MSW) {
      importSources(
        {
          chapterId: null,
          fileIds: ['mock_drive_file'],
          provider: 'google',
        },
        { onError: handleImportError }
      );
      onClose();
      return;
    }
    try {
      const { accessToken } = await api.get<{ accessToken: string }>(
        '/integrations/google/picker-token'
      );
      await loadGooglePicker();
      const g = window.google?.picker;
      if (!g) throw new Error('Google Picker did not finish loading.');
      const view = new g.DocsView(g.ViewId.DOCS);
      view.setIncludeFolders(true);
      const picker = new g.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setCallback((data: { action: string; docs?: { id: string }[] }) => {
          if (data.action === 'picked' && data.docs?.length) {
            importSources(
              {
                chapterId: null,
                fileIds: data.docs.map((d: { id: string }) => d.id),
                provider: 'google',
              },
              { onError: handleImportError }
            );
            onClose();
          }
        })
        .build() as { setVisible: (v: boolean) => void };
      picker.setVisible(true);
    } catch (error) {
      handleImportError(error);
    }
  }

  async function onGoogleClick() {
    if (!integrations?.google && !USE_MSW) {
      connect('google');
      return;
    }
    await openGooglePicker();
  }

  function onMicrosoftClick() {
    if (!integrations?.microsoft && !USE_MSW) {
      connect('microsoft');
      return;
    }
    setMsOpen(true);
  }
  return (
    <>
      <div className={cn(className)}>
        <div className="grid grid-cols-2 gap-3">
          <Button
            disabled={importSourcesIsPending}
            iconLeft="files"
            onClick={onGoogleClick}
            variant="outline"
          >
            Google Drive
          </Button>
          <Button
            disabled={importSourcesIsPending}
            iconLeft="files"
            onClick={onMicrosoftClick}
            variant="outline"
          >
            OneDrive
          </Button>
        </div>
        {!integrations?.google && !integrations?.microsoft && !USE_MSW && (
          <p className="t-meta text-center text-fg-muted">
            {m.source_cloud_connect_hint()}
          </p>
        )}
      </div>
      {msOpen && (
        <OneDriveImportDialog
          onClose={() => setMsOpen(false)}
          open
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}

function CreateFile({ className }: { className?: string }) {
  return <div className={cn(className)}>dummy</div>;
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
  const [mode, setMode] = useState('upload');
  return (
    <SimpleDialog
      className="min-h-150 max-w-3xl"
      onClose={onClose}
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
        <div className="h-full flex-1 overflow-hidden">
          <UploadFiles
            className={cn({ hidden: mode !== 'upload' })}
            onClose={onClose}
            workspaceId={workspaceId}
          />
          <ImportFiles
            className={cn({ hidden: mode !== 'import' })}
            onClose={onClose}
            workspaceId={workspaceId}
          />
          <CreateFile className={cn({ hidden: mode !== 'create' })} />
        </div>
      </div>
    </SimpleDialog>
  );
}
