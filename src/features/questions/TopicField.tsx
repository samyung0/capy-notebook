import { QUESTION_TOPICS_MAX } from '@/api/limits.generated';
import type { Topic } from '@/api/types';
import { checkboxVariants } from '@/components/ui/Checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import { selectTriggerVariants } from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** A question's own topics (Epo 2026-11-15, board "Several topics per
 * question"): the workspace's topics with checkboxes, at most
 * QUESTION_TOPICS_MAX ticked. A quiz's question without its own shows its
 * quiz's topic (`fallback`) ticked, which it counts toward (Epo 2026-11-15,
 * no "Quiz's topic" item); a bank's has a "No topic" item first (`empty`),
 * ticking it clears them. The trigger joins the names with commas. Ids the
 * workspace no longer holds read as none, as they count. Its label sits at
 * its left, as the question card's footer has it (board Main). */
export function TopicField({
  empty,
  fallback,
  onChange,
  topicIds = [],
  topics,
}: {
  /** The no-topic item's label (a bank's question). */
  empty?: string;
  /** What a question without its own counts toward: its quiz's topic. */
  fallback?: Topic;
  onChange: (topicIds: string[]) => void;
  topicIds?: string[];
  topics: Topic[];
}) {
  const ownTopics = topics.filter((topic) => topicIds.includes(topic.id));
  // Ticked: its own, else the quiz's it follows. Unticking the last one leaves
  // the question following the quiz again.
  const own =
    ownTopics.length > 0 || !fallback
      ? ownTopics
      : topics.filter((topic) => topic.id === fallback.id);
  const full = own.length >= QUESTION_TOPICS_MAX;
  // Kept in the workspace's order, as the trigger reads them.
  const toggle = (id: string) =>
    onChange(
      topics
        .filter((topic) => (topic.id === id) !== own.includes(topic))
        .map((topic) => topic.id)
    );
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="t-meta shrink-0 font-semibold text-fg-secondary">
        {m.quiz_editor_topics()}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={m.quiz_editor_topics()}
            className={cn(
              selectTriggerVariants(),
              'h-8 w-47.5 min-w-0 text-[13px]'
            )}
            type="button"
          >
            <span className="min-w-0 truncate">
              {own.length > 0
                ? own.map((topic) => topic.name).join(', ')
                : (empty ?? m.bank_no_topic())}
            </span>
            <Icon
              className="size-4 shrink-0 -translate-y-px text-fg-muted"
              name="chevronDown"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-65 p-1.5">
          {empty && (
            <>
              <TopicItem
                checked={own.length === 0}
                onSelect={() => onChange([])}
              >
                {empty}
              </TopicItem>
              <DropdownMenuSeparator />
            </>
          )}
          {topics.map((topic) => {
            const checked = own.includes(topic);
            return (
              <TopicItem
                checked={checked}
                disabled={full && !checked}
                key={topic.id}
                onSelect={() => toggle(topic.id)}
              >
                {topic.name}
              </TopicItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** A row ticked as a checkbox; the menu stays open for the next one. */
function TopicItem({
  checked,
  children,
  disabled,
  onSelect,
}: {
  checked: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      aria-checked={checked}
      className="min-h-8.5 gap-2.5"
      disabled={disabled}
      onSelect={(event) => {
        event.preventDefault();
        onSelect();
      }}
      role="menuitemcheckbox"
    >
      <span
        aria-hidden
        className={cn(checkboxVariants({ checked }), 'size-4 rounded-sm')}
      >
        {checked && <Icon className="size-3!" name="check" strokeWidth={2.4} />}
      </span>
      <span className="flex min-w-0 flex-1 items-center truncate">
        {children}
      </span>
    </DropdownMenuItem>
  );
}

/** The question without topics of its own when `topicIds` is empty. */
export const withTopics = <Q extends { topicIds?: string[] }>(
  question: Q,
  topicIds: string[]
): Q => {
  const { topicIds: _own, ...rest } = question;
  return (topicIds.length > 0 ? { ...rest, topicIds } : rest) as Q;
};
