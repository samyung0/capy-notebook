import type { ReviewMode, ReviewSuggestion } from '@/api/types';
import type { IconName } from '@/components/ui/Icon';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';

/** A suggested review's mode on screen: label, glyph and theme colour. */
export const REVIEW_MODE: Record<
  ReviewMode,
  { label: () => string; icon: IconName; className: string }
> = {
  fading: {
    className: 'text-tint-info-fg',
    icon: 'clock',
    label: m.review_mode_fading,
  },
  learned: {
    className: 'text-tint-success-fg',
    icon: 'sparkles',
    label: m.review_mode_learned,
  },
  tricky: {
    className: 'text-tint-warning-fg',
    icon: 'retry',
    label: m.review_mode_tricky,
  },
};

export const itemCount = (count: number) =>
  count === 1 ? m.review_items_one() : m.review_items({ count });

/** Why a suggestion is worth reviewing, worded from its evidence.
 * ponytail: phrasing to be tuned (Epo, 2026-10-10). */
export function reviewReason(s: ReviewSuggestion): string {
  const { evidence: ev } = s;
  if (s.mode === 'tricky') {
    if (ev.missed > 0 && ev.repeated > 0)
      return m.review_reason_tricky_both({
        missed: ev.missed,
        repeated: ev.repeated,
      });
    if (ev.missed > 0)
      return m.review_reason_tricky_missed({ missed: ev.missed });
    return m.review_reason_tricky_slipping();
  }
  const when = relativeTime(ev.lastPractisedAt);
  if (s.mode === 'learned') return m.review_reason_learned({ when });
  return m.review_reason_fading({
    forgotten: Math.max(ev.forgotten, 1),
    items: s.items,
    when,
  });
}

/** The group a suggestion or session names: its chapter, Others, or the
 * workspace itself. */
export function groupName(group: ReviewSuggestion['group'], chapter?: string) {
  if (group === 'others') return m.study_others();
  if (group === 'chapter') return chapter ?? '';
  return '';
}
