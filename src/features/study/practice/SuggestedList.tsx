import type { ReactNode } from 'react';
import type { ReviewSuggestion } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { REVIEW_MODE, reviewReason } from '../reviewText';
import { groupLabel } from './practiceText';

/** One practise row: its name, why, and the action that starts it. */
function PractiseRow({
  action,
  meta,
  name,
  onStart,
}: {
  action: string;
  meta: ReactNode;
  name: string;
  onStart: () => void;
}) {
  return (
    <li className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-divider border-b py-1.5 md:grid-cols-[260px_minmax(0,1fr)_auto]">
      <span className="truncate font-semibold">{name}</span>
      <span className="t-meta col-start-1 row-start-2 text-fg-muted md:col-start-auto md:row-start-auto">
        {meta}
      </span>
      <Button
        className="col-start-2 row-span-2 row-start-1 md:col-start-auto md:row-span-1 md:row-start-auto"
        onClick={onStart}
        size="sm"
        variant="outline"
      >
        {action}
      </Button>
    </li>
  );
}

/** Up to three picks with today's suggested-review wording (P2), on Practice
 * and on the Dashboard, which also ends the list with the whole workspace's
 * review (`onReviewAll`, Epo 2026-11-04, board D2). */
export function SuggestedList({
  list,
  onReviewAll,
  onStart,
}: {
  list: ReviewSuggestion[];
  onReviewAll?: () => void;
  onStart: (s: ReviewSuggestion) => void;
}) {
  return (
    <ul className="mt-1">
      {list.map((s) => (
        <PractiseRow
          action={m.practice_practise()}
          key={`${s.group}:${s.topicId ?? ''}`}
          meta={`${REVIEW_MODE[s.mode].label()} · ${reviewReason(s)}`}
          name={groupLabel(s.group, s.topicName)}
          onStart={() => onStart(s)}
        />
      ))}
      {onReviewAll && (
        <PractiseRow
          action={m.review_start()}
          meta={m.dashboard_workspace_review_meta()}
          name={m.dashboard_workspace_review()}
          onStart={onReviewAll}
        />
      )}
    </ul>
  );
}
