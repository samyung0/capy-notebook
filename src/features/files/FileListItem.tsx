import type { Chapter, SourceFile, UserColor } from '@/api/types';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import {
  ContentActions,
  toFileActionTarget,
} from '@/features/workspace/ContentActions';
import { cn } from '@/lib/cn';

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

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          'group relative flex items-center rounded-button hover:bg-surface-hover-bg',
          active && 'bg-surface-hover-bg'
        )}
      >
        <button
          className={cn(
            'flex w-full items-center gap-1.5 rounded-button px-1.5 py-1.5 pl-2 text-left',
            active && 'font-bold',
            processing && 'cursor-default'
          )}
          disabled={processing}
          onClick={() => !processing && onOpen(file.id)}
          type="button"
        >
          <Icon
            // hugeicon file icon looks a bit weirdly balanced
            className={cn('-translate-x-0.5', failed && 'text-solid-error')}
            name="files"
            size={15}
          />
          <span
            className={cn(
              'line-clamp-1 flex-1 translate-y-px truncate',
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
          <ContentActions
            chapters={chapters}
            color={color}
            content={toFileActionTarget(file)}
            display="hover"
            hoverClassName={cn(
              'absolute top-1/2 right-1 -translate-y-[calc(50%-2px)]',
              active && 'from-surface-hover-bg'
            )}
            onDeleted={() => onDeleted?.(file.id)}
            propertiesClassName="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2"
            propertyLabelClassName="text-fg-secondary"
            renameTitle="Rename file"
            workspaceId={workspaceId}
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
    </div>
  );
}
