import type {
  Chapter,
  MaterialRef,
  MaterialRefType,
  UserColor,
} from '@/api/types';
import { Spinner } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/Icon';
import {
  ContentActions,
  toMaterialActionTarget,
} from '@/features/workspace/ContentActions';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const MATERIAL_ICON: Record<MaterialRefType, IconName> = {
  diagram: 'diagram',
  flashcards: 'flashcards',
  mindmap: 'mindmap',
  note: 'write',
  quiz: 'quiz',
};

export function MaterialListItem({
  data: matRef,
  active,
  onOpen,
  onDelete,
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
  onDelete?: () => void;
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
        <Icon name={MATERIAL_ICON[matRef.type]} size={15} />
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
          includeDelete={!!onDelete}
          onMove={(chapterId) => onMove?.(chapterId)}
          onRequestDelete={onDelete}
          renameTitle={m.material_rename()}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}
