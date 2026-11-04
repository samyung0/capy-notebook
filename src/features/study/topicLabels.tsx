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

const MAX_SQUARES = 10;
export type SquareResult = 'right' | 'partial' | 'wrong' | 'unattempted';

/** A topic's squares (Epo 2026-11-04): one per question's latest result, grey
 * when not attempted, a quiz left partway included. A larger topic scales to
 * MAX_SQUARES, and any unattempted question keeps at least one grey. */
export function topicSquares(t: {
  right: number;
  partial: number;
  wrong: number;
  unattempted: number;
}): SquareResult[] {
  const results = [
    ['right', t.right],
    ['partial', t.partial],
    ['wrong', t.wrong],
    ['unattempted', t.unattempted],
  ] as const;
  const total = t.right + t.partial + t.wrong + t.unattempted;
  const repeat = (name: SquareResult, n: number) =>
    Array.from({ length: n }, () => name);
  if (total <= MAX_SQUARES) return results.flatMap(([k, n]) => repeat(k, n));
  const grey = t.unattempted
    ? Math.max(1, Math.round((t.unattempted / total) * MAX_SQUARES))
    : 0;
  const answered = t.right + t.partial + t.wrong;
  const room = MAX_SQUARES - grey;
  const shares = results.slice(0, 3).map(([k, n]) => {
    const exact = answered ? (n / answered) * room : 0;
    return { exact, k, n: Math.floor(exact) };
  });
  // Largest remainders take what rounding down left.
  let spare = room - shares.reduce((sum, s) => sum + s.n, 0);
  for (const s of [...shares].sort((a, b) => b.exact - b.n - (a.exact - a.n))) {
    if (spare-- > 0) s.n++;
  }
  return [
    ...shares.flatMap((s) => repeat(s.k, s.n)),
    ...repeat('unattempted', grey),
  ];
}
