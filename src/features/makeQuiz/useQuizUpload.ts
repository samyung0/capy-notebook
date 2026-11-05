import { useEffect, useRef } from 'react';
import {
  useBilling,
  useImportSources,
  useSourceUploadPolicy,
  useUploadSource,
  useWorkspace,
} from '@/api/hooks';
import { FILE_NAME_CHARACTER_LIMIT } from '@/api/limits.generated';
import type { SourceFile, SourceUploadPolicy } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { outOfCredits } from '@/features/billing/credits';
import {
  localRows,
  nameTooLong,
  sourceCreditEstimate,
  uploadParseMode,
  useSourceBatch,
  workspaceFileRoom,
  workspaceRoomToast,
} from '@/features/workspace/AddSourceDialog';
import { validateLocalSourceSelection } from '@/features/workspace/sourceDetails';
import {
  removeSourceTransfer,
  startSourceTransfer,
  useSourceTransfers,
} from '@/features/workspace/sourceTransfers';
import {
  capSourceUploads,
  isTextKind,
} from '@/features/workspace/sourceUpload';
import { m } from '@/i18n';
import { isQuizFile } from './makeQuiz';

/** A file that would be stored with no text: a run can't read it, so it isn't kept (Epo
 * 2026-11-05, "just show error saying that this file cannot be extracted"). Too many pages,
 * a password or no credits for its parse end here; a text file needs no parse. */
export function wouldStayUnread(
  kind: SourceFile['kind'],
  parseMode: string,
  policy: SourceUploadPolicy
) {
  return parseMode === 'none' && !isTextKind(kind, policy);
}

/** A file being added in the Make a quiz dialog: the normal upload and reading
 * path, saved to Files, hidden from members from its first moment (Epo
 * 2026-11-04) and in no topic, so it sits in Other files. `onRefused` takes back a row
 * whose file turned out unreadable before it was sent. */
export function useQuizUpload(
  workspaceId: string,
  onRefused: (key: string) => void
) {
  const refused = useRef(onRefused);
  refused.current = onRefused;
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const { data: policy } = useSourceUploadPolicy(workspaceId, {
    errorBoundary: false,
  });
  const { data: billing } = useBilling({ errorBoundary: false });
  const noCredits = !!billing && outOfCredits(billing);
  const batch = useSourceBatch(policy, []);
  const { mutateAsync: uploadSource } = useUploadSource(workspaceId);
  const { mutateAsync: importSources } = useImportSources(workspaceId, {
    errorToast: false,
  });
  const { remove, sources } = batch;
  const started = useRef(new Set<string>());

  // Each file goes as soon as the browser has its page estimate, which the
  // gateway's reservation needs.
  useEffect(() => {
    if (!policy) return;
    for (const source of sources) {
      const waiting =
        source.parseMode === 'fast' &&
        !!source.analysisInput &&
        source.analysisStatus !== 'ready' &&
        source.analysisStatus !== 'error';
      if (waiting || !source.file || started.current.has(source.key)) continue;
      started.current.add(source.key);
      const parseMode = uploadParseMode(source, policy, noCredits);
      if (wouldStayUnread(source.kind, parseMode, policy)) {
        remove(source);
        refused.current(source.key);
        userToast({
          description: source.name,
          title: noCredits
            ? m.source_upload_no_credits()
            : m.make_quiz_cannot_extract(),
          variant: 'error',
        });
        continue;
      }
      startSourceTransfer({
        importSources,
        limits: policy,
        local: [
          {
            estimatedCreditMicros: sourceCreditEstimate(
              { ...source, parseMode },
              policy
            ),
            file: source.file,
            hidden: true,
            key: source.key,
            kind: source.kind,
            name: source.name,
            pageCount:
              parseMode === 'fast'
                ? source.analysisResult?.pageCount
                : undefined,
            parseMode,
            topicId: null,
            topicName: null,
          },
        ],
        quietFailures: true,
        uploadSource,
        workspaceId,
      });
      remove(source);
    }
  }, [
    importSources,
    noCredits,
    policy,
    remove,
    sources,
    uploadSource,
    workspaceId,
  ]);

  // As in the Add dialog: rows waiting or on their way claim workspace room.
  const inFlight = useSourceTransfers(
    (state) =>
      state.transfers.filter(
        (row) =>
          row.workspaceId === workspaceId &&
          (row.stage === 'waiting' ||
            row.stage === 'uploading' ||
            row.stage === 'importing')
      ).length
  );

  /** Takes the picked files and returns their rows; a file over the plan's size or name
   * length says so and stays out, and so does one a run can't read or the workspace has
   * no room for. */
  function add(
    list: File[]
  ): { key: string; kind: SourceFile['kind']; name: string }[] {
    // Upload a file waits for the policy.
    if (!policy) return [];
    const { accepted, rejected } = validateLocalSourceSelection(list, policy);
    if (rejected.length > 0)
      userToast({
        description: rejected.map((item) => item.file.name).join(', '),
        title: m.source_files_too_large({
          mb: Math.round(policy.maxBytes / 1024 / 1024),
        }),
        variant: 'error',
      });
    const usable = accepted.filter((item) =>
      isQuizFile({ kind: item.kind, name: item.file.name })
    );
    if (usable.length < accepted.length)
      userToast({
        description: accepted
          .filter((item) => !usable.includes(item))
          .map((item) => item.file.name)
          .join(', '),
        title: m.make_quiz_cannot_extract(),
        variant: 'error',
      });
    const named = usable.filter((item) => !nameTooLong(item.file.name));
    if (named.length < usable.length)
      userToast({
        description: usable
          .filter((item) => !named.includes(item))
          .map((item) => item.file.name)
          .join(', '),
        title: m.source_name_too_long({ max: FILE_NAME_CHARACTER_LIMIT }),
        variant: 'error',
      });
    const { filesLimit, workspaceRoom } = workspaceFileRoom(workspace);
    const capped = capSourceUploads(
      sources.length + inFlight,
      named,
      workspaceRoom
    );
    if (capped.rejected > 0) workspaceRoomToast(workspaceRoom, filesLimit);
    const rows = localRows(capped.accepted, policy, noCredits);
    batch.add(rows);
    return rows.map(({ key, kind, name }) => ({ key, kind, name }));
  }

  /** A row removed from the dialog: its upload stops if it can still. */
  function cancel(key: string) {
    started.current.add(key);
    const waiting = sources.find((source) => source.key === key);
    if (waiting) remove(waiting);
    removeSourceTransfer(key);
  }

  return { add, cancel, policy };
}
