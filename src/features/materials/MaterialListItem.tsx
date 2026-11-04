import { Link } from '@tanstack/react-router';
import type { MouseEventHandler } from 'react';
import type { MaterialRef, Topic, UserColor } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { Spinner } from '@/components/ui/feedback';
import { ContentActions } from '@/features/workspace/ContentActions';
import { toMaterialActionTarget } from '@/features/workspace/contentActionTarget';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';

export function MaterialListItem({
  data: matRef,
  active,
  onOpen,
  onDeleted,
  topics,
  color,
  onMove,
  workspaceId,
  generating = false,
  readOnly = false,
  canClone = false,
  menu = true,
  indent = false,
}: {
  data: MaterialRef;
  active: boolean;
  onOpen?: MouseEventHandler<HTMLAnchorElement>;
  onDeleted?: () => void;
  /** All workspace topics, for the "Move to…" menu. */
  topics: Topic[];
  color?: UserColor;
  /** File this material under a topic (null = unfile). */
  onMove?: (topicId: string | null) => void;
  workspaceId: string;
  generating?: boolean;
  readOnly?: boolean;
  /** Members and editors may copy the material elsewhere (workspace.canClone). */
  canClone?: boolean;
  /** The reader's own progress on this material, while progress is on. */
  /** The hover ⋮; touch lists (the top Files drawer) leave it out. */
  menu?: boolean;
  /** Inside a topic or Other files: the icon starts under the group's name. */
  indent?: boolean;
}) {
  const hoverMenu = menu && (!readOnly || canClone) && !generating;
  return (
    <div
      className={cn(
        'group relative flex min-h-7.5 items-center rounded-button pr-1.5 hover:bg-surface-hover-bg group-data-[dragging]/file-tree:bg-transparent!',
        indent ? 'pl-7' : 'pl-2',
        active && 'bg-surface-hover-bg'
      )}
    >
      {/* Board T3's row, as FileListItem's; a quiz reads "<title> · quiz". */}
      <Link
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-button text-left font-medium text-fg-secondary',
          active && 'text-fg'
        )}
        disabled={generating}
        draggable={false}
        onClick={onOpen}
        params={{ workspaceId }}
        replace
        search={{ material: matRef.id }}
        to="/workspaces/$workspaceId"
      >
        <FileIcon className="size-4" name={materialIconName(matRef.type)} />
        <span className="min-w-0 flex-1 translate-y-px truncate">
          {matRef.type === 'quiz'
            ? m.files_quiz_row({ title: matRef.title })
            : matRef.title}
        </span>
        {generating && <Spinner className="size-4 shrink-0" />}
      </Link>
      {hoverMenu && (
        <ContentActions
          canClone={canClone}
          color={color}
          confirmInMenu
          content={toMaterialActionTarget(matRef)}
          display="hover"
          hoverClassName={cn(
            'absolute top-1/2 right-1 -translate-y-1/2 pl-0 [--scroll-fade-start:0px]',
            active && 'bg-surface-hover-bg'
          )}
          hoverIconContainerClassName="p-1 focus-visible:ring-inset"
          onDeleted={onDeleted}
          onMove={(topicId) => onMove?.(topicId)}
          readOnly={readOnly}
          renameTitle={m.material_rename()}
          topics={topics}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}
