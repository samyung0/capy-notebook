import { Link, useNavigate } from '@tanstack/react-router';
import { type MouseEventHandler, useState } from 'react';
import type { SourceFile, Topic, UserColor } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import type { StudyRow } from '@/features/study/studyItems';
import { AddSourceDialog } from '@/features/workspace/AddSourceDialog';
import { ContentActions } from '@/features/workspace/ContentActions';
import { toFileActionTarget } from '@/features/workspace/contentActionTarget';
import {
  type RetryProcessing,
  retryFailedFile,
} from '@/features/workspace/retryProcessing';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import { fileCanClone, fileIsIngesting } from './fileUtils';

/** A file row in the workspace Files panel (board T3). Opens the file in the
 * center pane, shows ingest progress, and exposes a hover action menu (rename /
 * properties / delete); progress marks stay on the Study page. */
export function FileListItem({
  file,
  active,
  onOpen,
  workspaceId,
  color,
  topics = [],
  onDeleted,
  readOnly = false,
  canClone = false,
  canMoveTo = false,
  retry,
  retryPending = false,
  study,
  menu = true,
  indent = false,
}: {
  file: SourceFile;
  active: boolean;
  onOpen: MouseEventHandler<HTMLAnchorElement>;
  workspaceId: string;
  /** Workspace topics, for the "Move to topic…" picker. */
  topics?: Topic[];
  color?: UserColor;
  onDeleted?: (id: string) => void;
  /** Shared workspace viewers can open files but cannot mutate them. */
  readOnly?: boolean;
  /** Members and editors may copy the file elsewhere (workspace.canClone). */
  canClone?: boolean;
  /** Move to… into another workspace or topic (fileCanMoveTo); others get
   * the topic-only Move. */
  canMoveTo?: boolean;
  /** The owner's Retry processing for a failed file, one mutation for the
   * whole list; absent when the reader may not retry. */
  retry?: RetryProcessing;
  /** This file's Retry processing is still running (useRetryingFileIds). */
  retryPending?: boolean;
  /** The reader's own progress on this file, while progress is on. */
  study?: StudyRow;
  /** The hover ⋮; touch lists (the top Files drawer) leave it out and act
   * from the open file's header instead. */
  menu?: boolean;
  /** Inside a topic or Other files: the icon starts under the group's name. */
  indent?: boolean;
}) {
  const ingesting = fileIsIngesting(file.status);
  const waitingForBytes = ingesting && !file.hasBytes;
  const failed = file.status === 'failed';
  const [retrying, setRetrying] = useState(false);
  const navigate = useNavigate();
  const hoverMenu = menu && (!readOnly || canClone);

  return (
    <div className="relative flex flex-col">
      <div
        className={cn(
          'group relative flex min-h-7.5 items-center rounded-button pr-1.5 hover:bg-surface-hover-bg group-data-[dragging]/file-tree:bg-transparent!',
          indent ? 'pl-7' : 'pl-2',
          active && 'bg-surface-hover-bg'
        )}
      >
        {/* Board T3's row: 30px, a 16px icon, one truncated line; the open
            file shows by the row's background, not its weight. */}
        <Link
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-button text-left font-medium text-fg-secondary',
            active && 'text-fg',
            waitingForBytes && 'cursor-default'
          )}
          disabled={waitingForBytes}
          draggable={false}
          onClick={waitingForBytes ? undefined : onOpen}
          params={{ workspaceId }}
          replace
          search={{ file: file.id }}
          to="/workspaces/$workspaceId"
        >
          <FileIcon className="size-4" name={fileIconName(file)} />
          <span
            className={cn(
              'min-w-0 flex-1 translate-y-px truncate',
              study?.state === 'removed' && 'text-fg-muted',
              failed && 'text-solid-error'
            )}
          >
            {file.name}
          </span>
        </Link>
        {hoverMenu && (
          <ContentActions
            canClone={canClone && fileCanClone(file)}
            canMoveTo={canMoveTo}
            color={color}
            confirmInMenu
            content={toFileActionTarget(file)}
            display="hover"
            hoverClassName={cn(
              'absolute top-1/2 right-1 -translate-y-1/2 pl-0 [--scroll-fade-start:0px]',
              active && 'bg-surface-hover-bg'
            )}
            hoverIconContainerClassName="p-1 focus-visible:ring-inset"
            leadingItems={
              readOnly
                ? []
                : [
                    ...(failed && retry
                      ? [
                          {
                            disabled: retryPending,
                            icon: 'refresh' as const,
                            label: m.files_retry_processing(),
                            onClick: () =>
                              retryFailedFile(file, retry, () =>
                                setRetrying(true)
                              ),
                            warning: true,
                          },
                        ]
                      : []),
                    ...(study?.menuItems ?? []),
                  ]
            }
            onDeleted={() => onDeleted?.(file.id)}
            // The open file follows itself into its new workspace.
            onMoved={
              active
                ? (moved) =>
                    void navigate({
                      params: { workspaceId: moved.workspaceId },
                      replace: true,
                      search: { file: moved.id },
                      to: '/workspaces/$workspaceId',
                    })
                : undefined
            }
            propertiesClassName="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2"
            propertyLabelClassName="text-fg-secondary"
            readOnly={readOnly}
            renameTitle={m.files_rename()}
            topics={topics}
            workspaceId={workspaceId}
          />
        )}
      </div>
      {retrying && (
        <AddSourceDialog
          onClose={() => setRetrying(false)}
          open
          retryFile={file}
          workspaceId={workspaceId}
        />
      )}
      {failed && (
        <div
          className={cn(
            't-label z-10 mb-0.5 font-medium text-fg-muted tracking-normal',
            indent ? 'pr-2 pl-7' : 'px-2'
          )}
        >
          {m.files_processing_error()}
        </div>
      )}
      {ingesting && (
        <div
          className={cn('z-10 mr-1.5 mb-0.5', indent ? 'pr-2 pl-7' : 'px-2')}
        >
          <ProgressBar height={4} tone={color} value={50} />
        </div>
      )}
    </div>
  );
}
