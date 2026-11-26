import type { ReactNode } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** How far a question is answered, as its number shows it. */
export type NumberState = 'complete' | 'answered' | 'empty';

/** A report's band for a question's average, its number filled in its tint. */
export type NumberTone = 'success' | 'warning' | 'error';

const TONE: Record<NumberTone, string> = {
  error: 'border-transparent bg-tint-error text-tint-error-fg',
  success: 'border-transparent bg-tint-success text-tint-success-fg',
  warning: 'border-transparent bg-tint-warning text-tint-warning-fg',
};

export type NumberItem = {
  id: string;
  /** In place of the state's words for a screen reader (a report's average). */
  label?: string;
  marked?: boolean;
  state: NumberState;
  tone?: NumberTone;
};

const stateLabel = (state: NumberState) =>
  state === 'complete'
    ? m.assignment_legend_answered()
    : state === 'answered'
      ? m.assignment_legend_part_answered()
      : m.assignment_legend_not_answered();

/** A bookmark's mark (Epo 2026-11-25, option A): a small dark ribbon, the
 * number's hanging off its top edge, the legend's inline. */
function Ribbon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-3 w-2 bg-fg [clip-path:polygon(0_0,100%_0,100%_100%,50%_72%,0_100%)]',
        className
      )}
    />
  );
}

/** One question's number: filled when answered, dashed when partly, ringed
 * when open, with a bookmark's ribbon off its top edge. */
function NumberSquare({
  className,
  compact = false,
  current,
  item,
  number,
  onOpen,
}: {
  className?: string;
  /** The phone strip's smaller square takes a smaller ribbon. */
  compact?: boolean;
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
        item.label ?? stateLabel(item.state),
        ...(item.marked ? [m.assignment_legend_bookmarked()] : []),
      ].join(', ')}
      className={cn(
        'relative grid cursor-pointer place-items-center rounded-[10px] border font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action',
        item.tone
          ? TONE[item.tone]
          : item.state === 'complete'
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
      {/* Over the border, even the open one's 2px. */}
      {item.marked && (
        <Ribbon
          className={cn(
            'absolute -top-0.5',
            compact ? 'right-[5px] h-2.5 w-[7px]' : 'right-[7px]'
          )}
        />
      )}
    </button>
  );
}

/**
 * An online assessment's questions as numbers only (Epo 2026-11-19, board A):
 * a grid in the list's place on wider screens, with what each look means
 * under it, and a strip above the question on phones (Q679 B). The member's
 * page and staff's Preview both show it, and the report's By question with
 * each number in its average's tint (Epo 2026-11-22).
 */
export function QuestionNumbers({
  bookmarks = false,
  current,
  items,
  legend,
  onOpen,
}: {
  /** Bookmarks can be set, so the legend names them. */
  bookmarks?: boolean;
  current: string | undefined;
  items: NumberItem[];
  /** In place of the answered ones' legend: what the tints mean. */
  legend?: { label: string; tone: NumberTone }[];
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
        {legend?.map((item) => (
          <span className="inline-flex items-center gap-1.5" key={item.tone}>
            <span className={cn('size-3.5 rounded-[4px]', TONE[item.tone])} />
            {item.label}
          </span>
        ))}
        {!legend && (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3.5 rounded-[4px] bg-tint-accent-1" />
              {m.assignment_legend_answered()}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded-[4px] border border-solid-accent-1 border-dashed" />
              {m.assignment_legend_part_answered()}
            </span>
          </>
        )}
        {bookmarks && (
          <span className="inline-flex items-center gap-1.5">
            <Ribbon className="inline-block" />
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
                compact
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
