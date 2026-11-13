import { type ReactNode, type RefObject, useState } from 'react';
import { createAssignmentBodyFilesMax } from '@/api/gen/validators';
import { useItems } from '@/api/hooks';
import type {
  Assignment,
  AssignmentFileRef,
  Item,
  ItemKind,
} from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import {
  ChooseFileButton,
  FileMenuNote,
  FileMenuRow,
  FileSearchMenu,
  RemoveFileButton,
} from '@/features/files/FileSearchMenu';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { useDebounced } from '@/lib/useDebounced';
import { assignmentFileIcon } from './todoParts';

/** A file or block on a task's form: what its row shows, and what is sent. */
export interface TaskFile {
  icon: FileIconName;
  id: string;
  name: string;
  ref: AssignmentFileRef;
  /** Where it sits; none for one with no workspace. */
  workspaceName?: string;
}

const refId = (ref: AssignmentFileRef) => ref.fileId ?? ref.materialId ?? '';

const savedFile = (file: Assignment['files'][number]): TaskFile => ({
  icon: assignmentFileIcon(file),
  id: file.fileId ?? file.materialId ?? '',
  name: file.name,
  ref: file.fileId ? { fileId: file.fileId } : { materialId: file.materialId },
  workspaceName: file.workspaceName,
});

/** A Files row a task can hold: a file or a block; never a hand-in, an
 * embedded image or a canvas. */
function listedFile(item: Item): TaskFile | null {
  if (item.type === 'file') {
    const { file } = item;
    return {
      icon: fileIconName(file),
      id: file.id,
      name: file.name,
      ref: { fileId: file.id },
      workspaceName: file.workspaceName || undefined,
    };
  }
  if (item.type === 'material' && item.material.kind !== 'canvas') {
    const { material } = item;
    return {
      icon: materialIconName(material.kind),
      id: material.id,
      name: material.title,
      ref: { materialId: material.id },
      workspaceName: material.workspaceName || undefined,
    };
  }
  return null;
}

/**
 * A task's Files (Epo 2026-11-11): the files of a task one sets oneself come
 * from any workspace or none, whatever workspace the task is in, so Choose a
 * file searches everything its maker can open and each row names where the
 * file sits. An assignment's files stay its class's (`FilesField`). Choose a
 * file stays above the rows (Epo 2026-11-12).
 */
export function TaskFilesField({
  onChange,
  onPicked,
  picked,
  saved,
  value,
}: {
  onChange: (files: AssignmentFileRef[]) => void;
  onPicked: (file: TaskFile) => void;
  /** The rows picked since the form opened. The form holds them, so they
   * outlive this field while Kind is Marked. */
  picked: TaskFile[];
  /** The files of the task being edited. */
  saved: Assignment['files'];
  value: AssignmentFileRef[];
}) {
  // The form holds ids alone; what each row shows comes from the task as it
  // was read and from the rows picked since.
  const known = new Map([
    ...saved.map((file) => [refId(file), savedFile(file)] as const),
    ...picked.map((file) => [file.id, file] as const),
  ]);
  const rows = value.flatMap((ref) => known.get(refId(ref)) ?? []);
  const remove = (id: string) =>
    onChange(value.filter((ref) => refId(ref) !== id));
  return (
    <div className="flex flex-col gap-2">
      <ChooseFileRow count={value.length}>
        <TaskFileMenu
          empty={m.assignment_no_files_match()}
          full={value.length >= createAssignmentBodyFilesMax}
          held={value.map(refId)}
          label={m.assignment_search_files()}
          onPick={(file) => {
            onPicked(file);
            onChange([...value, file.ref]);
          }}
          onUnpick={remove}
          trigger={<ChooseFileButton />}
        />
      </ChooseFileRow>
      {rows.length > 0 && (
        <ul className="w-full">
          {rows.map((file) => (
            <li
              className="flex min-h-8 items-center gap-2.5 pl-2"
              key={file.id}
            >
              <FileIcon className="size-4 shrink-0" name={file.icon} />
              <span className="min-w-0 flex-1 truncate font-semibold">
                {file.name}
              </span>
              {file.workspaceName && (
                <span className="t-meta max-w-[40%] shrink-0 truncate text-fg-muted">
                  {file.workspaceName}
                </span>
              )}
              <RemoveFileButton
                label={m.action_remove()}
                onClick={() => remove(file.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Choose a file, with the files cap under it once a task or an assignment
 * holds as many as the server takes (its menu's unticked rows are disabled
 * then; the trigger stays, so the menu still opens and closes). */
export function ChooseFileRow({
  children,
  count,
}: {
  children: ReactNode;
  count: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      {children}
      {count >= createAssignmentBodyFilesMax && (
        <span className="t-meta text-fg-muted">
          {m.assignment_files_max({ max: createAssignmentBodyFilesMax })}
        </span>
      )}
    </div>
  );
}

/** Choose a file's menu (Epo 2026-11-12: Make a quiz's search menu, not a
 * Search dialog): a field over the Files page's All files, newest first until
 * something is typed. The files already on the task are ticked. With
 * `onUnpick` (Files) it stays open for more and a ticked row takes its file off
 * (Epo 2026-11-12); a task's Quiz field opens it over quizzes alone (`kinds`),
 * closing on its one pick. */
export function TaskFileMenu({
  empty,
  full = false,
  held,
  kinds,
  label,
  onPick,
  onUnpick,
  trigger,
}: {
  /** What it says when nothing matches. */
  empty: string;
  /** At the files cap: only a ticked row can be pressed. */
  full?: boolean;
  held: string[];
  kinds?: ItemKind[];
  /** The search field's label and placeholder. */
  label: string;
  onPick: (file: TaskFile) => void;
  onUnpick?: (id: string) => void;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <FileSearchMenu
      label={label}
      onOpenChange={setOpen}
      open={open}
      searchLabel={label}
      trigger={trigger}
    >
      {(query, list) => (
        <TaskFileRows
          empty={empty}
          full={full}
          held={held}
          kinds={kinds}
          list={list}
          onPick={(file) => {
            if (held.includes(file.id)) onUnpick?.(file.id);
            else onPick(file);
            if (!onUnpick) setOpen(false);
          }}
          query={query}
        />
      )}
    </FileSearchMenu>
  );
}

/** The menu's rows for what is typed, a page at a time. */
function TaskFileRows({
  empty,
  full,
  held,
  kinds,
  list,
  onPick,
  query,
}: {
  empty: string;
  full: boolean;
  held: string[];
  kinds?: ItemKind[];
  list: RefObject<HTMLDivElement | null>;
  onPick: (file: TaskFile) => void;
  query: string;
}) {
  const q = useDebounced(query, 400).trim();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isFetchNextPageError,
    isPending,
    isPlaceholderData,
    refetch,
  } = useItems({ kinds, q: q || undefined, scope: 'all' });
  if (isPending || isPlaceholderData)
    return <SkeletonList className="px-1" count={4} rowHeight={36} />;
  if (!data && isError)
    return (
      <InlineErrorState
        className="py-4"
        errorId={unexpectedErrorId(error)}
        message={m.search_error()}
        onRetry={() => void refetch()}
      />
    );
  const files = (data?.pages ?? [])
    .flatMap((page) => page.items)
    .flatMap((item) => listedFile(item) ?? []);
  return (
    <>
      {files.map((file) => (
        <FileMenuRow
          className="disabled:cursor-default"
          disabled={full && !held.includes(file.id)}
          key={file.id}
          onClick={() => onPick(file)}
          role="option"
          selected={held.includes(file.id)}
        >
          <FileIcon className="size-4 shrink-0" name={file.icon} />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="t-meta max-w-[40%] shrink-0 truncate font-medium text-fg-muted">
            {file.workspaceName ?? m.todo_no_workspace()}
          </span>
        </FileMenuRow>
      ))}
      {files.length === 0 && !hasNextPage && (
        <FileMenuNote>{empty}</FileMenuNote>
      )}
      <ListEnd
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        isFetchNextPageError={isFetchNextPageError}
        root={list}
      />
    </>
  );
}
