import type { ReviewSuggestion } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { REVIEW_MODE, reviewReason } from '../reviewText';
import { groupLabel } from './practiceText';

/** Up to three picks with today's suggested-review wording (P2), on Practice
 * and on the Dashboard. */
export function SuggestedList({
  list,
  onStart,
}: {
  list: ReviewSuggestion[];
  onStart: (s: ReviewSuggestion) => void;
}) {
  return (
    <ul className="mt-1">
      {list.map((s) => (
        <li
          className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-divider border-b py-1.5 md:grid-cols-[260px_minmax(0,1fr)_auto]"
          key={`${s.group}:${s.topicId ?? ''}`}
        >
          <span className="truncate font-semibold">
            {groupLabel(s.group, s.topicName)}
          </span>
          <span className="t-meta col-start-1 row-start-2 text-fg-muted md:col-start-auto md:row-start-auto">
            {`${REVIEW_MODE[s.mode].label()} · ${reviewReason(s)}`}
          </span>
          <Button
            className="col-start-2 row-span-2 row-start-1 md:col-start-auto md:row-span-1 md:row-start-auto"
            onClick={() => onStart(s)}
            size="sm"
            variant="outline"
          >
            {m.practice_practise()}
          </Button>
        </li>
      ))}
    </ul>
  );
}
