import { useState } from 'react';
import type { Chapter, MaterialRef, MaterialRefType } from '@/api/types';
import { Spinner } from '@/components/ui/feedback';
import { HoverActions } from '@/components/ui/HoverActions';
import { Icon, type IconName } from '@/components/ui/Icon';
import { MoveToChapterDialog } from '@/features/workspace/MoveToChapterDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const MATERIAL_ICON: Record<MaterialRefType, IconName> = {
  deck: 'flashcards',
  diagram: 'diagram',
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
  onMove,
  generating = false,
  readOnly = false,
}: {
  data: MaterialRef;
  active: boolean;
  onOpen: () => void;
  onDelete?: () => void;
  /** All workspace chapters, for the "Move to…" menu. */
  chapters: Chapter[];
  /** File this material under a chapter (null = unfile). */
  onMove?: (chapterId: string | null) => void;
  generating?: boolean;
  readOnly?: boolean;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const items = [
    {
      icon: 'files' as IconName,
      label: 'Move file',
      onClick: () => setMoveOpen(true),
    },
    ...(onDelete
      ? [
          {
            danger: true,
            icon: 'trash' as IconName,
            label: m.action_delete(),
            onClick: onDelete,
          },
        ]
      : []),
  ];
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-button hover:bg-surface-hover-bg',
        generating ? 'pr-1' : 'pr-8',
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
        <>
          <HoverActions
            className="absolute top-1/2 right-1 -translate-y-1/2"
            items={items}
          />
          <MoveToChapterDialog
            chapters={chapters}
            currentChapterId={matRef.chapterId}
            onClose={() => setMoveOpen(false)}
            onSelect={(chapterId) => onMove?.(chapterId)}
            open={moveOpen}
          />
        </>
      )}
    </div>
  );
}
