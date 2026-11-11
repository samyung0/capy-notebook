import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState } from 'react';
import { searchQueryQMax } from '@/api/gen/validators';
import { useItems } from '@/api/hooks';
import type {
  Assignment,
  AssignmentFileRef,
  Item,
  ItemKind,
} from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { ListEnd } from '@/components/app/ListEnd';
import { PanelScrollRoot } from '@/components/app/layout';
import {
  type Thumbnail,
  ThumbnailPanel,
} from '@/components/app/ThumbnailPanel';
import { BASE_BUTTON_STYLE, Button } from '@/components/ui/Button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/Dialog';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
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
  thumbnail?: Thumbnail;
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
      thumbnail: {
        fileKind: file.kind,
        preview: file.preview,
        thumbnailUrl: file.thumbnailUrl,
      },
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
      thumbnail: { preview: material.preview },
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
  const [picking, setPicking] = useState(false);
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
      <Button
        iconLeft="plus"
        onClick={() => setPicking(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        {m.assignment_add_file()}
      </Button>
      {picking && (
        <FilePicker
          empty={m.assignment_no_files_match()}
          held={value.map(refId)}
          label={m.assignment_search_files()}
          onClose={() => setPicking(false)}
          onPick={(file) => {
            onPicked(file);
            onChange([...value, file.ref]);
            setPicking(false);
          }}
          title={m.assignment_add_file()}
        />
      )}
    </div>
  );
}

/** Add a file's picker, drawn as Search is (Epo 2026-11-11): a field over the
 * Files page's All files, newest first until something is typed. A row adds
 * the file and closes; files already on the task are left out. A task's Quiz
 * field opens the same one over quizzes alone (`kinds`). */
export function FilePicker({
  empty,
  held,
  kinds,
  label,
  onClose,
  onPick,
  title,
}: {
  /** What it says when nothing matches. */
  empty: string;
  held: string[];
  kinds?: ItemKind[];
  /** The search field's label and placeholder. */
  label: string;
  onClose: () => void;
  onPick: (file: TaskFile) => void;
  title: string;
}) {
  const [q, setQ] = useState('');
  const query = useDebounced(q, 400).trim();
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
  } = useItems({ kinds, q: query || undefined, scope: 'all' });
  const files = (data?.pages ?? [])
    .flatMap((page) => page.items)
    .flatMap((item) => listedFile(item) ?? [])
    .filter((file) => !held.includes(file.id));
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        cardScrollContainerClassName="p-0 max-sm:pb-0 sm:p-0"
        className="top-[12vh] translate-y-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        showCloseButton={false}
      >
        {/* Search's own header: phones show close and a title above the field,
            wider screens only the field with close beside. */}
        <div className="flex shrink-0 items-start gap-1 pt-3 pr-4 pb-1 pl-1.5 sm:contents">
          <DialogClose asChild>
            <IconButton
              className="-translate-y-px sm:hidden"
              icon="x"
              label={m.action_close()}
              size="sm"
              variant="ghost-hover"
            />
          </DialogClose>
          <DialogPrimitive.Title className="t-large-card-title py-2 text-lg leading-tight sm:sr-only">
            {title}
          </DialogPrimitive.Title>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:max-h-[70vh] sm:flex-none">
          <div className="flex items-center gap-2.5 border-divider border-b px-4 py-3">
            <span className="pl-1.5">
              <Icon className="size-4.25" name="search" />
            </span>
            <Input
              aria-label={label}
              maxLength={searchQueryQMax}
              onChange={(e) => setQ(e.target.value)}
              placeholder={label}
              value={q}
              variant="transparent"
              wrapperClassName="flex-1 translate-y-px"
            />
            <DialogClose asChild>
              <IconButton
                className="max-sm:hidden"
                icon="x"
                label={m.action_close()}
                size="sm"
                variant="ghost-hover"
              />
            </DialogClose>
          </div>
          <div className="relative min-h-40 flex-1 overflow-auto px-2 py-2.5 max-sm:pb-[calc(--spacing(2.5)+max(env(safe-area-inset-bottom),var(--keyboard-inset,0px)))]">
            {isPending || isPlaceholderData ? (
              <SkeletonList className="px-1" count={5} rowHeight={48} />
            ) : !data && isError ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <InlineErrorState
                  className="-translate-y-1/2"
                  errorId={unexpectedErrorId(error)}
                  message={m.search_error()}
                  onRetry={() => void refetch()}
                />
              </div>
            ) : (
              <>
                {files.map((file) => (
                  <button
                    className={cn(
                      BASE_BUTTON_STYLE,
                      'flex w-full items-center gap-3 px-2 py-2.5 text-left hover:bg-surface-hover-bg'
                    )}
                    key={file.id}
                    onClick={() => onPick(file)}
                    type="button"
                  >
                    <ThumbnailPanel
                      icon={file.icon}
                      small
                      {...file.thumbnail}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg text-sm">
                        {file.name}
                      </span>
                      <span className="block truncate text-fg-muted text-xs">
                        {file.workspaceName ?? m.todo_no_workspace()}
                      </span>
                    </span>
                  </button>
                ))}
                {files.length === 0 && !hasNextPage && (
                  <div className="absolute inset-0 flex items-center justify-center text-center">
                    <span className="-translate-y-1/2">{empty}</span>
                  </div>
                )}
                {/* The dialog scrolls inside the viewport, not the page's panel. */}
                <PanelScrollRoot.Provider value={undefined}>
                  <ListEnd
                    fetchNextPage={fetchNextPage}
                    hasNextPage={hasNextPage}
                    isFetchingNextPage={isFetchingNextPage}
                    isFetchNextPageError={isFetchNextPageError}
                  />
                </PanelScrollRoot.Provider>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
