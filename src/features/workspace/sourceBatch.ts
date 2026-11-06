import { useCallback, useEffect, useRef, useState } from 'react';
// A typed name has the file name limit, as a rename has it.
import { updateFileBodyNameMax as fileNameMax } from '@/api/gen/validators';
import type { FileKind, SourceUploadPolicy } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { audioLengthOrRefuse } from './audioDuration';
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
  analysisFailurePatch,
  initialAnalysisStatus,
  type SourceAnalysisStatus,
  sourceAnalysisBlocksSubmit,
  type validateLocalSourceSelection,
} from './sourceDetails';
import type { SourceProvider } from './sourceTransfers';
import {
  defaultParseMode,
  MAX_FILES_PER_WORKSPACE,
  type ParseMode,
} from './sourceUpload';

/* The rows a file being added becomes, for the Add file dialog and Make a quiz.
 * No pickers here: MSAL stays with the dialog. */

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
  contentType: string;
  driveId?: string;
  file?: File;
  fileId?: string;
  key: string;
  kind: FileKind;
  name: string;
  origin: 'local' | 'remote';
  parseMode: ParseMode;
  provider?: SourceProvider;
  sizeBytes: number;
  sizeEstimate: boolean;
  topicId: string | null;
  topicName: string | null;
}

export function workspaceFileRoom(
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

export function workspaceRoomToast(workspaceRoom: number, filesLimit: number) {
  userToast({
    title:
      workspaceRoom <= 0
        ? m.source_workspace_file_full({ limit: filesLimit })
        : m.source_upload_too_many({ count: workspaceRoom }),
    variant: 'error',
  });
}

/** Server limit on files.name, counted in code points like the API. */
export function nameTooLong(name: string): boolean {
  return [...name].length > fileNameMax;
}

export function localRows(
  selections: ReturnType<typeof validateLocalSourceSelection>['accepted'],
  policy: SourceUploadPolicy,
  noCredits: boolean
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
      contentType: file.type || 'application/octet-stream',
      file,
      key,
      kind,
      name: file.name,
      origin: 'local',
      parseMode: noCredits ? 'none' : defaultParseMode(file, kind, policy),
      sizeBytes: file.size,
      sizeEstimate: false,
      topicId: null,
      topicName: null,
    };
  });
}

/** Expected cost of one source at the policy rates: audio by whole seconds,
 * fast-parsed documents by text-layer and vision-read page count, everything
 * else free. */
export function sourceCreditEstimate(
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

export type SourceBatch = ReturnType<typeof useSourceBatch>;

/** One tab's pending sources: analysis and row settings. Upload and Import
 * each own one, so their lists never mix. */
export function useSourceBatch(
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

/** An Upload row's parse mode (Epo 2026-11-03): the default, else none when
 * the payer is out of AI credits or the browser's analysis refuses fast
 * parsing, since the Upload tab has no parse-mode choice. */
export function uploadParseMode(
  source: PendingSource,
  policy: SourceUploadPolicy,
  noCredits: boolean
): ParseMode {
  if (noCredits) return 'none';
  const analysed =
    source.analysisStatus === 'ready' || source.analysisStatus === 'error';
  return source.parseMode === 'fast' &&
    analysed &&
    sourceAnalysisBlocksSubmit(source, policy)
    ? 'none'
    : source.parseMode;
}
