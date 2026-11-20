import { type ReactNode, useState } from 'react';
import { makeFileGradedQuizBodyGradedQuizTotalMarksMax } from '@/api/gen/validators';
import {
  useCopyQuizToGradedQuiz,
  useFiles,
  useMakeFileGradedQuiz,
  usePractice,
} from '@/api/hooks';
import type { AssignmentFormReq, SourceFile } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Button } from '@/components/ui/Button';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { SkeletonList, Spinner } from '@/components/ui/feedback';
import { Input } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui/SearchInput';
import { userToast } from '@/components/ui/userToast';
import { FileMenuRow } from '@/features/files/FileSearchMenu';
import { fileExt, formatFileSize } from '@/features/files/fileUtils';
import { matchesSearch } from '@/features/workspace/PanelSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { questionsLabel } from '../practice/practiceText';

const WHOLE = /^\d+$/;

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
  failed,
  label,
  onPick,
  picked,
  query,
  rows,
}: {
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
        {query ? m.common_no_matches() : m.common_nothing_yet()}
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
 * them, and its files, in the Convert file menu's rows. A quiz is copied whole
 * into the new graded quiz with its settings in one request (`POST
 * /api/quizzes/{id}/graded-copy`), the original staying as it is. A file
 * becomes the question paper, read live, of a graded quiz members answer by
 * upload, marked by hand out of the marks typed here (`POST
 * /api/files/{id}/graded-quiz`). */
export function useExistingQuizPicker({
  gradedQuiz,
  onMade,
  workspaceId,
}: {
  /** The graded quiz's settings; none where the tab isn't offered. */
  gradedQuiz?: AssignmentFormReq;
  onMade: (assignmentId: string) => void;
  workspaceId: string;
}) {
  const {
    data: practice,
    error: practiceError,
    isError: practiceFailed,
    refetch: refetchPractice,
  } = usePractice(workspaceId, {
    enabled: !!gradedQuiz,
    errorBoundary: false,
  });
  const {
    data: files,
    error: filesError,
    isError: filesFailed,
    refetch: refetchFiles,
  } = useFiles(workspaceId, { errorBoundary: false });
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string>();
  const [marks, setMarks] = useState('');
  const { isPending: copying, mutate: copy } =
    useCopyQuizToGradedQuiz(workspaceId);
  const { isPending: making, mutate: makeFromFile } =
    useMakeFileGradedQuiz(workspaceId);
  const busy = copying || making;
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
  const total = Number(marks);
  const list: ReactNode = (
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
  );

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
      <div className="mt-2 min-h-60 flex-1 overflow-y-auto">{list}</div>
    </>
  );
  const note =
    chosen?.kind === 'file' ? (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-2 font-semibold text-fg">
          {m.assignment_field_total_marks()}
          <Input
            autoComplete="off"
            inputMode="numeric"
            onChange={(event) => {
              // Whole marks, 1 to the most, refused key by key as MarkField's.
              const next = event.target.value;
              if (
                next === '' ||
                (WHOLE.test(next) &&
                  Number(next) <= makeFileGradedQuizBodyGradedQuizTotalMarksMax)
              )
                setMarks(next === '' ? '' : String(Number(next)));
            }}
            value={marks}
            wrapperClassName="h-8 w-18 px-2.5"
          />
        </label>
        <span className="t-meta text-fg-secondary">
          {m.assignment_paper_by_upload()}
        </span>
      </span>
    ) : chosen ? (
      <span className="font-semibold text-fg">{chosen.meta}</span>
    ) : null;
  const done = {
    onError: (error: unknown) =>
      userToast({
        title: errorCopy(error, m.assignment_save_failed()),
        variant: 'error',
      }),
    onSuccess: (created: { id: string }) => onMade(created.id),
  };
  const action = (
    <Button
      disabled={busy || !chosen || (chosen.kind === 'file' && !(total >= 1))}
      onClick={() => {
        if (!chosen || !gradedQuiz) return;
        // An untitled graded quiz is named after its quiz, or its file
        // without the extension.
        const ext = chosen.kind === 'file' ? fileExt(chosen.name) : '';
        const name = ext ? chosen.name.slice(0, -ext.length - 1) : chosen.name;
        const named = {
          ...gradedQuiz,
          // By characters, so an emoji isn't cut in half.
          title: gradedQuiz.title || Array.from(name).slice(0, 120).join(''),
        };
        if (chosen.kind === 'quiz')
          copy({ gradedQuiz: named, quizId: chosen.id }, done);
        else
          makeFromFile(
            {
              fileId: chosen.id,
              gradedQuiz: { ...named, totalMarks: total },
            },
            done
          );
      }}
      type="button"
    >
      {busy ? <Spinner /> : m.assignment_create()}
    </Button>
  );
  return { action, body, note };
}
