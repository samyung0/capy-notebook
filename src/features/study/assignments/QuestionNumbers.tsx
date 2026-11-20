import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** How far a question is answered, as its number shows it. */
export type NumberState = 'complete' | 'answered' | 'empty';

export type NumberItem = {
  id: string;
  marked?: boolean;
  state: NumberState;
};

const stateLabel = (state: NumberState) =>
  state === 'complete'
    ? m.assignment_legend_answered()
    : state === 'answered'
      ? m.assignment_legend_part_answered()
      : m.assignment_legend_not_answered();

/** One question's number: filled when answered, dashed when partly, ringed
 * when open, with a bookmark in its corner. */
function NumberSquare({
  className,
  current,
  item,
  number,
  onOpen,
}: {
  className?: string;
  current: boolean;
  item: NumberItem;
  number: number;
  onOpen: () => void;
}) {
  return (
    <button
      aria-current={current ? 'step' : undefined}
      aria-label={[
        m.assignment_question_n({ number }),
        stateLabel(item.state),
        ...(item.marked ? [m.assignment_legend_bookmarked()] : []),
      ].join(', ')}
      className={cn(
        'relative grid cursor-pointer place-items-center rounded-[10px] border font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action',
        item.state === 'complete'
          ? 'border-transparent bg-tint-accent-1 text-tint-accent-1-fg'
          : item.state === 'answered'
            ? 'border-solid-accent-1 border-dashed text-fg'
            : 'border-line text-fg hover:bg-surface-hover-bg',
        current && 'border-2 border-solid-accent-1 border-solid',
        className
      )}
      data-question-number={item.id}
      onClick={onOpen}
      type="button"
    >
      {number}
      {item.marked && (
        <Icon
          className="absolute top-0 right-0.5 text-solid-accent-1"
          name="bookmark"
          size={11}
        />
      )}
    </button>
  );
}

/**
 * An online assessment's questions as numbers only (Epo 2026-11-19, board A):
 * a grid in the list's place on wider screens, with what each look means
 * under it, and a strip above the question on phones (Q679 B). The member's
 * page and staff's Preview both show it.
 */
export function QuestionNumbers({
  bookmarks = false,
  current,
  items,
  onOpen,
}: {
  /** Bookmarks can be set, so the legend names them. */
  bookmarks?: boolean;
  current: string | undefined;
  items: NumberItem[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ol className="grid grid-cols-6 gap-2 px-1.5">
        {items.map((item, i) => (
          <li key={item.id}>
            <NumberSquare
              className="aspect-square w-full"
              current={item.id === current}
              item={item}
              number={i + 1}
              onOpen={() => onOpen(item.id)}
            />
          </li>
        ))}
      </ol>
      <div className="mt-auto flex flex-wrap gap-x-3.5 gap-y-2 px-1.5 pt-3 pb-1 text-fg-secondary text-xs">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3.5 rounded-[4px] bg-tint-accent-1" />
          {m.assignment_legend_answered()}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-[4px] border border-solid-accent-1 border-dashed" />
          {m.assignment_legend_part_answered()}
        </span>
        {bookmarks && (
          <span className="inline-flex items-center gap-1.5">
            <Icon className="text-solid-accent-1" name="bookmark" size={12} />
            {m.assignment_legend_bookmarked()}
          </span>
        )}
      </div>
    </div>
  );
}

/** Phones: the same numbers in one row above the question, `start` before
 * them (the way out). */
export function NumberStrip({
  current,
  items,
  onOpen,
  start,
}: {
  current: string | undefined;
  items: NumberItem[];
  onOpen: (id: string) => void;
  start?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center border-divider border-b md:hidden">
      {start && <span className="shrink-0 pl-2">{start}</span>}
      <nav aria-label={m.assignment_questions_nav()} className="min-w-0 flex-1">
        <ol className="flex gap-2 overflow-x-auto px-2.5 py-2.5 [scrollbar-width:none]">
          {items.map((item, i) => (
            <li className="shrink-0" key={item.id}>
              <NumberSquare
                className="size-9"
                current={item.id === current}
                item={item}
                number={i + 1}
                onOpen={() => onOpen(item.id)}
              />
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}
