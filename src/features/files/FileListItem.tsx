import { useState } from 'react';
import { useDeleteFile, useMoveFile, useUpdateFile } from '@/api/hooks';
import type { Chapter, SourceFile, UserColor } from '@/api/types';
import {
  Button,
  ConfirmDialog,
  HoverActions,
  Icon,
  Input,
  ProgressBar,
  SimpleDialog,
  Spinner,
} from '@/components/ui';
import { MoveToChapterDialog } from '@/features/workspace/MoveToChapterDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

function formatSize(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/** A file row in the workspace sidebar. Opens the file in the center pane, shows
 * ingest progress, and exposes a hover action menu (rename / properties /
 * delete) mirroring the chapter row pattern. */
export function FileListItem({
  file,
  active,
  onOpen,
  workspaceId,
  color,
  chapters = [],
  onDeleted,
  readOnly = false,
}: {
  file: SourceFile;
  active: boolean;
  onOpen: (id: string) => void;
  workspaceId: string;
  /** Workspace chapters, for the "Move to chapter…" picker. */
  chapters?: Chapter[];
  color?: UserColor;
  onDeleted?: (id: string) => void;
  /** Shared workspace viewers can open files but cannot mutate them. */
  readOnly?: boolean;
}) {
  const processing = file.status === 'processing';
  const failed = file.status === 'failed';
  const updateFile = useUpdateFile(workspaceId);
  const moveFile = useMoveFile(workspaceId);
  const delFile = useDeleteFile(workspaceId);

  const [renameOpen, setRenameOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [name, setName] = useState(file.name);

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          'group relative flex items-center rounded-row pr-8 hover:bg-surface-hover-bg',
          active && 'bg-surface-hover-bg'
        )}
      >
        <button
          className={cn(
            'flex w-full items-center gap-1.5 rounded-row px-1.5 py-1.5 pl-2 text-left',
            active && 'font-bold',
            processing && 'cursor-default'
          )}
          disabled={processing}
          onClick={() => !processing && onOpen(file.id)}
          type="button"
        >
          <Icon
            className={cn(failed && 'text-solid-error')}
            name="files"
            size={15}
          />
          <span
            className={cn(
              'line-clamp-2 flex-1 translate-y-px',
              failed && 'text-solid-error'
            )}
          >
            {file.name}
          </span>
        </button>
        {processing && (
          <div className="mr-0.5">
            <Spinner />
          </div>
        )}
        {!readOnly && (
          <HoverActions
            className="absolute top-1/2 right-1 -translate-y-1/2"
            iconContainerClassName="hover:bg-unset"
            items={[
              {
                icon: 'write',
                label: m.action_rename(),
                onClick: () => {
                  setName(file.name);
                  setRenameOpen(true);
                },
              },
              {
                icon: 'files',
                label: 'Move File',
                onClick: () => setMoveOpen(true),
              },
              {
                icon: 'help',
                label: 'Properties',
                onClick: () => setPropsOpen(true),
              },
              {
                danger: true,
                icon: 'trash',
                label: m.action_delete(),
                onClick: () => setConfirmOpen(true),
              },
            ]}
          />
        )}
      </div>
      {failed && (
        <div className="pl-2 font-medium text-solid-error text-xs">
          Error Processing File
        </div>
      )}
      {processing && (
        <div className="mr-1.5 mb-0.5 ml-6">
          <ProgressBar height={4} tone={color} value={file.ingestPct ?? 0} />
        </div>
      )}

      <SimpleDialog
        footer={
          <>
            <Button onClick={() => setRenameOpen(false)} variant="ghost">
              Cancel
            </Button>
            <Button
              onClick={() => {
                const n = name.trim();
                if (n) updateFile.mutate({ id: file.id, name: n });
                setRenameOpen(false);
              }}
            >
              Save
            </Button>
          </>
        }
        onClose={() => setRenameOpen(false)}
        open={renameOpen}
        title="Rename file"
      >
        <Input onChange={(e) => setName(e.target.value)} value={name} />
      </SimpleDialog>

      <SimpleDialog
        onClose={() => setPropsOpen(false)}
        open={propsOpen}
        title="File properties"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <Row label="Name" value={file.name} />
          <Row label="Type" value={file.kind.toUpperCase()} />
          <Row label="Size" value={formatSize(file.sizeKb)} />
          <Row label="Status" value={file.status ?? 'ready'} />
          <Row label="Added" value={new Date(file.addedAt).toLocaleString()} />
        </dl>
      </SimpleDialog>

      <ConfirmDialog
        body="This removes the file from the workspace. This cannot be undone."
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          delFile.mutate(file.id);
          onDeleted?.(file.id);
        }}
        open={confirmOpen}
        title={`Delete ${file.name}?`}
      />

      <MoveToChapterDialog
        chapters={chapters}
        color={color}
        currentChapterId={file.chapterId}
        onClose={() => setMoveOpen(false)}
        onSelect={(chapterId) => moveFile.mutate({ chapterId, id: file.id })}
        open={moveOpen}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <p className="text-fg-muted">{label}</p>
      <p className="truncate">{value}</p>
    </>
  );
}
