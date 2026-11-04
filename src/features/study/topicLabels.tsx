import type { SummaryTopic } from '@/api/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

type TopicLabel = SummaryTopic['label'];

/** A topic's label on screen (Epo 2026-11-03: Khan Academy's names, keeping
 * Needs practice), in plan §5's colours. */
const LABEL: Record<TopicLabel, { className: string; name: () => string }> = {
  attempted: {
    className: 'border border-strong text-fg-secondary',
    name: m.topic_label_attempted,
  },
  familiar: {
    className: 'bg-tint-info text-tint-info-fg',
    name: m.topic_label_familiar,
  },
  mastered: {
    className: 'bg-solid-success text-white',
    name: m.topic_label_mastered,
  },
  needs_practice: {
    className: 'bg-tint-warning text-tint-warning-fg',
    name: m.topic_label_needs_practice,
  },
  not_started: {
    className: 'px-0 text-fg-muted',
    name: m.learning_not_started,
  },
  proficient: {
    className: 'bg-tint-success text-tint-success-fg',
    name: m.topic_label_proficient,
  },
};

/** "Familiar", or "3 Familiar" when counting a workspace's topics. */
export function LabelChip({
  count,
  label,
}: {
  count?: number;
  label: TopicLabel;
}) {
  const { className, name } = LABEL[label];
  return (
    <span
      className={cn(
        't-meta inline-flex h-[22px] items-center whitespace-nowrap rounded-md px-1.75 font-semibold',
        className
      )}
    >
      {count === undefined || label === 'not_started'
        ? name()
        : `${count} ${name()}`}
    </span>
  );
}
