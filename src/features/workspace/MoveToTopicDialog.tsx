import type { Topic, UserColor } from '@/api/types';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';

/** Topic picker for moving a file or material into a topic (membership).
 * Selecting a row calls onSelect and closes; Other files unfiles (null). */
export function MoveToTopicDialog({
  open,
  onClose,
  topics,
  currentTopicId,
  onSelect,
  color,
  title,
}: {
  open: boolean;
  onClose: () => void;
  topics: Topic[];
  currentTopicId: string | null;
  onSelect: (topicId: string | null) => void;
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
    <SimpleDialog
      onClose={onClose}
      open={open}
      title={title ?? m.move_to_topic()}
    >
      <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-auto">
        {topics.length > 0 && (
          <>
            <button
              className="flex h-9 w-full items-center gap-2.5 rounded-button px-2.5 py-2 text-left transition-colors hover:bg-surface-hover-bg"
              onClick={() => choose(null)}
              style={styleCls(currentTopicId === null)}
              type="button"
            >
              <Icon
                className="shrink-0 -translate-y-px"
                name="removeFromTopic"
              />
              <span
                className={cn(
                  'flex-1 truncate',
                  currentTopicId === null && 'font-bold'
                )}
              >
                {m.topic_other_files()}
              </span>
              {currentTopicId === null && (
                <Icon className="shrink-0" name="check" />
              )}
            </button>
            {topics.map((c) => {
              const active = c.id === currentTopicId;
              return (
                <button
                  className="flex h-9 w-full items-center gap-2.5 rounded-button px-2.5 py-2 text-left transition-colors hover:bg-surface-hover-bg"
                  key={c.id}
                  onClick={() => choose(c.id)}
                  style={styleCls(active)}
                  type="button"
                >
                  <Icon className="shrink-0 -translate-y-px" name="topic" />
                  <span
                    className={cn('flex-1 truncate', active && 'font-bold')}
                  >
                    {c.name}
                  </span>
                  {active && <Icon className="shrink-0" name="check" />}
                </button>
              );
            })}
          </>
        )}
        {topics.length === 0 && (
          <div className="px-2.5 py-3">{m.move_no_topics()}</div>
        )}
      </div>
    </SimpleDialog>
  );
}
