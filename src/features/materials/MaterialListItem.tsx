import { Link } from '@tanstack/react-router';
import type { MouseEventHandler } from 'react';
import type { Chapter, MaterialRef, UserColor } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { Spinner } from '@/components/ui/feedback';
import { StudyMark, type StudyRow } from '@/features/study/studyItems';
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
  chapters,
  color,
  onMove,
  workspaceId,
  generating = false,
  readOnly = false,
  study,
}: {
  data: MaterialRef;
  active: boolean;
  onOpen?: MouseEventHandler<HTMLAnchorElement>;
  onDeleted?: () => void;
  /** All workspace chapters, for the "Move to…" menu. */
  chapters: Chapter[];
  color?: UserColor;
  /** File this material under a chapter (null = unfile). */
  onMove?: (chapterId: string | null) => void;
  workspaceId: string;
  generating?: boolean;
  readOnly?: boolean;
  /** The reader's own progress on this material, while progress is on. */
  study?: StudyRow;
}) {
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-button px-2 hover:bg-surface-hover-bg group-data-[dragging]/file-tree:bg-transparent!',
        active && 'bg-surface-hover-bg'
      )}
    >
      <Link
        className={cn(
          'flex w-full items-center gap-2 rounded-button py-1.5 text-left',
          active && 'font-bold'
        )}
        disabled={generating}
        draggable={false}
        onClick={onOpen}
        params={{ workspaceId }}
        replace
        search={{ material: matRef.id }}
        to="/workspaces/$workspaceId"
      >
        <FileIcon className="size-3.75" name={materialIconName(matRef.type)} />
        <span
          className={cn(
            'line-clamp-2 flex-1 translate-y-px',
            study?.state === 'removed' && 'text-fg-muted'
          )}
        >
          {matRef.title}
        </span>
        <StudyMark className="mr-6" state={study?.state} />
        {generating && <Spinner className="size-4 shrink-0" />}
      </Link>
      {!readOnly && !generating && (
        <ContentActions
          chapters={chapters}
          color={color}
          content={toMaterialActionTarget(matRef)}
          display="hover"
          hoverClassName={cn(
            'absolute top-1/2 right-1 -translate-y-1/2 pl-0 [--scroll-fade-start:0px]',
            active && 'bg-surface-hover-bg'
          )}
          hoverIconContainerClassName="p-1"
          leadingItems={study?.menuItems}
          onDeleted={onDeleted}
          onMove={(chapterId) => onMove?.(chapterId)}
          renameTitle={m.material_rename()}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}
