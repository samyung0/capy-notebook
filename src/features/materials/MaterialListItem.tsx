import type { Chapter, MaterialRef, UserColor } from '@/api/types';
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
  chapters,
  color,
  onMove,
  workspaceId,
  generating = false,
  readOnly = false,
}: {
  data: MaterialRef;
  active: boolean;
  onOpen: () => void;
  onDeleted?: () => void;
  /** All workspace chapters, for the "Move to…" menu. */
  chapters: Chapter[];
  color?: UserColor;
  /** File this material under a chapter (null = unfile). */
  onMove?: (chapterId: string | null) => void;
  workspaceId: string;
  generating?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-button hover:bg-surface-hover-bg',
        generating ? 'pr-1' : 'pr-1.5',
        active && 'bg-surface-hover-bg'
      )}
    >
      <button
        className={cn(
          'flex w-full items-center gap-2 rounded-button px-1.5 py-1.5 text-left',
          active && 'font-bold'
        )}
        disabled={generating}
        onClick={onOpen}
        type="button"
      >
        <FileIcon className="size-3.75" name={materialIconName(matRef.type)} />
        <span className="line-clamp-2 flex-1 translate-y-px">
          {matRef.title}
        </span>
        {generating && <Spinner className="size-4 shrink-0" />}
      </button>
      {!readOnly && !generating && (
        <ContentActions
          chapters={chapters}
          color={color}
          content={toMaterialActionTarget(matRef)}
          display="hover"
          hoverClassName={cn(
            'absolute top-1/2 right-1 -translate-y-[calc(50%-2px)]',
            active && 'from-surface-hover-bg'
          )}
          onDeleted={onDeleted}
          onMove={(chapterId) => onMove?.(chapterId)}
          renameTitle={m.material_rename()}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}
