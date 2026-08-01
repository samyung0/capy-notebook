import type { Chapter, UserColor } from '@/api/types';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { userColorPair } from '@/lib/userColor';

/** Chapter picker for moving a file or material into a chapter (membership).
 * Selecting a row calls onSelect and closes; "No chapter" unfiles (null). */
export function MoveToChapterDialog({
  open,
  onClose,
  chapters,
  currentChapterId,
  onSelect,
  color,
  title = 'Move to chapter',
}: {
  open: boolean;
  onClose: () => void;
  chapters: Chapter[];
  currentChapterId: string | null;
  onSelect: (chapterId: string | null) => void;
  color?: UserColor;
  title?: string;
}) {
  const pair = userColorPair(color);
  function choose(id: string | null) {
    onSelect(id);
    onClose();
  }
  const styleCls = (active: boolean): React.CSSProperties =>
    active
      ? {
          background:
            pair.bg === 'transparent' ? 'var(--color-surface-dark)' : pair.bg,
          color: pair.fg,
        }
      : {};
  return (
    <SimpleDialog onClose={onClose} open={open} title={title}>
      <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-auto">
        {chapters.length > 0 && (
          <>
            <button
              className="flex w-full items-center gap-2 rounded-button px-2.5 py-2 text-left transition-colors hover:bg-surface-hover-bg"
              onClick={() => choose(null)}
              style={styleCls(currentChapterId === null)}
              type="button"
            >
              {/* <Icon name="chevronLeft" size={15} className="shrink-0" /> */}
              <span className="flex-1 truncate">No chapter</span>
              {currentChapterId === null && (
                <Icon className="size-3.75 shrink-0" name="check" />
              )}
            </button>
            {chapters.map((c) => {
              const active = c.id === currentChapterId;
              return (
                <button
                  className="flex w-full items-center gap-2 rounded-button px-2.5 py-2 text-left transition-colors hover:bg-surface-hover-bg"
                  key={c.id}
                  onClick={() => choose(c.id)}
                  style={styleCls(active)}
                  type="button"
                >
                  <Icon
                    className="size-3.75 shrink-0 -translate-y-px"
                    name="files"
                  />
                  <span className="flex-1 truncate">{c.name}</span>
                  {active && (
                    <Icon className="size-3.75 shrink-0" name="check" />
                  )}
                </button>
              );
            })}
          </>
        )}
        {chapters.length === 0 && (
          <div className="px-2.5 py-3 text-sm">
            No chapters yet. Create a chapter first.
          </div>
        )}
      </div>
    </SimpleDialog>
  );
}
