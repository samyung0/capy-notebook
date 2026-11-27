import { useState } from 'react';
import {
  useCopyQuizToGradedQuiz,
  useFiles,
  useMakeFileGradedQuiz,
  usePractice,
} from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { SearchInput } from '@/components/ui/SearchInput';
import { FileMenuRow } from '@/features/files/FileSearchMenu';
import { fileExt, formatFileSize } from '@/features/files/fileUtils';
import { matchesSearch } from '@/features/workspace/PanelSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { questionsLabel } from '../practice/practiceText';
import type { GradedSource } from './gradedSource';

export type PickRow = {
  id: string;
  icon: FileIconName;
  meta: string;
  name: string;
};
type Row = PickRow & { kind: 'quiz' | 'file' };

/** A workspace's files that can be read as a question paper, those with
 * stored bytes, in the pick list's rows; a hidden one says so, as members'
 * attempts would show none of it until they start. */
export function paperFileRows(
  files: SourceFile[],
  meta?: (file: SourceFile) => string | undefined
): PickRow[] {
  return files
    .filter((file) => file.hasBytes)
    .map((file) => ({
      icon: fileIconName({ kind: file.kind, name: file.name }),
      id: file.id,
      meta:
        meta?.(file) ??
        (file.hidden
          ? m.assignment_paper_hidden()
          : formatFileSize(file.sizeBytes)),
      name: file.name,
    }));
}

/** One pick from a radio list in the Convert file menu's rows, with its
 * loading, failed and empty states and a search over the names. */
export function PickList({
  empty = m.common_nothing_yet(),
  failed,
  label,
  onPick,
  picked,
  query,
  rows,
}: {
  /** What an empty list says (not a search that matches nothing). */
  empty?: string;
  failed?: { error: unknown; retry: () => void };
  label: string;
  onPick: (id: string) => void;
  picked: string | undefined;
  query: string;
  /** Undefined while loading. */
  rows: PickRow[] | undefined;
}) {
  if (failed)
    return (
      <ErrorState
        className="h-auto py-16"
        errorId={unexpectedErrorId(failed.error)}
        onRetry={failed.retry}
        title={m.assignment_existing_load_failed()}
        variant="panel"
      />
    );
  if (!rows) return <SkeletonList count={8} rowHeight={36} />;
  const shown = rows.filter((row) => matchesSearch(row.name, query));
  if (shown.length === 0)
    return (
      <p className="t-meta mt-3 text-fg-muted">
        {query ? m.common_no_matches() : empty}
      </p>
    );
  return (
    <div aria-label={label} role="radiogroup">
      {shown.map((row) => {
        const on = row.id === picked;
        return (
          <FileMenuRow
            aria-checked={on}
            className={cn('font-normal', on && 'bg-surface-hover-bg')}
            key={row.id}
            onClick={() => onPick(row.id)}
            role="radio"
          >
            <span
              aria-hidden
              className={cn(
                'size-4 shrink-0 rounded-full border-[1.5px] border-fg-muted',
                on && 'border-[5px] border-action'
              )}
            />
            <FileIcon className="size-4 shrink-0" name={row.icon} />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span className="t-meta shrink-0 text-fg-muted">{row.meta}</span>
          </FileMenuRow>
        );
      })}
    </div>
  );
}

/** New graded quiz's Existing file tab (Epo 2026-11-16, first of its tabs;
 * any file 2026-11-20, mock Main): the workspace's quizzes, as Practice lists
 * them, and its files, in the Convert file menu's rows. Its pick goes on to
 * Settings, whose Create sends it: a quiz is copied whole into the new graded
 * quiz in one request (`POST /api/quizzes/{id}/graded-copy`), the original
 * staying as it is; a file becomes the question paper, read live, of a graded
 * quiz members answer by upload, marked by hand out of Settings' Points
 * (`POST /api/files/{id}/graded-quiz`). */
export function useExistingQuizPicker({
  enabled,
  onMade,
  workspaceId,
}: {
  /** The tab is offered: New graded quiz's. */
  enabled: boolean;
  onMade: (assignmentId: string) => void;
  workspaceId: string;
}) {
  const {
    data: practice,
    error: practiceError,
    isError: practiceFailed,
    refetch: refetchPractice,
  } = usePractice(workspaceId, { enabled, errorBoundary: false });
  const {
    data: files,
    error: filesError,
    isError: filesFailed,
    refetch: refetchFiles,
  } = useFiles(workspaceId, { errorBoundary: false });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string>();
  const { mutateAsync: copy } = useCopyQuizToGradedQuiz(workspaceId);
  const { mutateAsync: makeFromFile } = useMakeFileGradedQuiz(workspaceId);
  // The workspace's own: a practice quiz made only for oneself has none.
  const rows: Row[] | undefined =
    practice && files
      ? [
          ...practice.items
            .filter((row) => row.kind === 'quiz' && !row.onlyYou)
            .map((row) => ({
              icon: materialIconName('quiz'),
              id: row.id,
              kind: 'quiz' as const,
              meta: questionsLabel(row.size),
              name: row.title,
            })),
          ...paperFileRows(files).map((row) => ({
            ...row,
            kind: 'file' as const,
          })),
        ]
      : undefined;
  const chosen = rows?.find((row) => row.id === picked);

  const body = (
    <>
      <SearchInput
        aria-label={m.assignment_existing_search()}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={m.assignment_existing_search()}
        value={query}
        wrapperClassName="h-8 min-w-0"
      />
      {/* Fills the dialog's one height, as the bank's list does. */}
      <div className="mt-2 min-h-60 flex-1 overflow-y-auto">
        <PickList
          failed={
            practiceFailed
              ? { error: practiceError, retry: () => void refetchPractice() }
              : filesFailed
                ? { error: filesError, retry: () => void refetchFiles() }
                : undefined
          }
          label={m.assignment_tab_existing()}
          onPick={setPicked}
          picked={picked}
          query={query}
          rows={rows}
        />
      </div>
    </>
  );
  const note = chosen && (
    <span className="font-semibold text-fg">{chosen.meta}</span>
  );
  const made = (created: { id: string }) => onMade(created.id);
  // A file is named without its extension.
  const ext = chosen?.kind === 'file' ? fileExt(chosen.name) : '';
  const source: GradedSource | undefined = chosen && {
    file: chosen.kind === 'file',
    name: ext ? chosen.name.slice(0, -ext.length - 1) : chosen.name,
    quizId: chosen.kind === 'quiz' ? chosen.id : undefined,
    send: (gradedQuiz) =>
      chosen.kind === 'quiz'
        ? copy({ gradedQuiz, quizId: chosen.id }).then(made)
        : makeFromFile({ fileId: chosen.id, gradedQuiz }).then(made),
  };
  return { body, note, source };
}
