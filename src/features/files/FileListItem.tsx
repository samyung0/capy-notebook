import type { Chapter, SourceFile, UserColor } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ContentActions } from '@/features/workspace/ContentActions';
import { toFileActionTarget } from '@/features/workspace/contentActionTarget';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import { fileIsIngesting } from './fileUtils';

/** A file row in the workspace sidebar. Opens the file in the center pane, shows
 * ingest progress, and exposes a hover action menu (rename / properties /
 * delete) mirroring the chapter row pattern. */
export function FileListItem({
  beforeDelete,
  file,
  active,
  onOpen,
  workspaceId,
  color,
  chapters = [],
  onDeleted,
  readOnly = false,
}: {
  beforeDelete?: () => boolean;
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
  const ingesting = fileIsIngesting(file.status);
  const failed = file.status === 'failed';

  return (
    <div className="relative flex flex-col">
      <div
        className={cn(
          'group relative flex items-center rounded-button px-2 hover:bg-surface-hover-bg group-data-[dragging]/file-tree:bg-transparent!',
          active && 'bg-surface-hover-bg'
        )}
      >
        <button
          className={cn(
            'flex w-full items-center gap-1.5 rounded-button py-1.5 text-left',
            active && 'font-bold',
            ingesting && 'cursor-default'
          )}
          disabled={ingesting}
          onClick={() => !ingesting && onOpen(file.id)}
          type="button"
        >
          <FileIcon className="size-3.75" name={fileIconName(file)} />
          <span
            className={cn(
              'line-clamp-2 flex-1 translate-y-px',
              failed && 'text-solid-error'
            )}
          >
            {file.name}
          </span>
        </button>
        {!readOnly && (
          <ContentActions
            beforeDelete={beforeDelete}
            chapters={chapters}
            color={color}
            content={toFileActionTarget(file)}
            display="hover"
            hoverClassName={cn(
              'absolute top-1/2 right-1 -translate-y-1/2',
              active && 'bg-surface-hover-bg'
            )}
            onDeleted={() => onDeleted?.(file.id)}
            propertiesClassName="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2"
            propertyLabelClassName="text-fg-secondary"
            renameTitle={m.files_rename()}
            workspaceId={workspaceId}
          />
        )}
      </div>
      {failed && (
        <div className="t-label z-10 -mt-1 mb-0.5 px-2 font-medium text-fg-muted tracking-normal">
          {m.files_processing_error()}
        </div>
      )}
      {ingesting && (
        <div className="z-10 -mt-0.5 mr-1.5 mb-0.5 px-2">
          <ProgressBar height={4} tone={color} value={50} />
        </div>
      )}
    </div>
  );
}
