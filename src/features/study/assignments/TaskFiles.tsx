import { type ReactNode, type RefObject, useState } from 'react';
import { useItems } from '@/api/hooks';
import type {
  Assignment,
  AssignmentFileRef,
  Item,
  ItemKind,
} from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { Button } from '@/components/ui/Button';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { IconButton } from '@/components/ui/IconButton';
import {
  FileMenuNote,
  FileMenuRow,
  FileSearchMenu,
} from '@/features/files/FileSearchMenu';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { useDebounced } from '@/lib/useDebounced';
import { assignmentFileIcon } from './TodoSection';

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
 * from any workspace or none, whatever workspace the task is in, so Add a file
 * searches everything its maker can open and each row names where the file
 * sits. An assignment's files stay its class's (`FilesField`).
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
  return (
    <div className="flex flex-col items-start gap-2">
      {rows.length > 0 && (
        <ul className="w-full">
          {rows.map((file) => (
            <li
              className="flex min-h-9.5 items-center gap-2.5 border-divider border-b"
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
              <IconButton
                className="size-7"
                icon="x"
                label={m.action_remove()}
                onClick={() =>
                  onChange(value.filter((ref) => refId(ref) !== file.id))
                }
                type="button"
              />
            </li>
          ))}
        </ul>
      )}
      <TaskFileMenu
        empty={m.assignment_no_files_match()}
        held={value.map(refId)}
        label={m.assignment_search_files()}
        onPick={(file) => {
          onPicked(file);
          onChange([...value, file.ref]);
        }}
        trigger={
          <Button iconLeft="plus" size="sm" type="button" variant="outline">
            {m.assignment_add_file()}
          </Button>
        }
        wide
      />
    </div>
  );
}

/** Add a file's menu (Epo 2026-11-12: Make a quiz's search menu, not a
 * Search dialog): a field over the Files page's All files, newest first until
 * something is typed. A row adds the file and closes; files already on the
 * task are left out. A task's Quiz field opens the same one over quizzes alone
 * (`kinds`). */
export function TaskFileMenu({
  empty,
  held,
  kinds,
  label,
  onPick,
  trigger,
  wide,
}: {
  /** What it says when nothing matches. */
  empty: string;
  held: string[];
  kinds?: ItemKind[];
  /** The search field's label and placeholder. */
  label: string;
  onPick: (file: TaskFile) => void;
  trigger: ReactNode;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <FileSearchMenu
      label={label}
      onOpenChange={setOpen}
      open={open}
      searchLabel={label}
      trigger={trigger}
      wide={wide}
    >
      {(query, list) => (
        <TaskFileRows
          empty={empty}
          held={held}
          kinds={kinds}
          list={list}
          onPick={(file) => {
            onPick(file);
            setOpen(false);
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
  held,
  kinds,
  list,
  onPick,
  query,
}: {
  empty: string;
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
    .flatMap((item) => listedFile(item) ?? [])
    .filter((file) => !held.includes(file.id));
  return (
    <>
      {files.map((file) => (
        <FileMenuRow
          aria-selected={false}
          key={file.id}
          onClick={() => onPick(file)}
          role="option"
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
