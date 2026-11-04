import type {
  Assignment,
  AssignmentFormReq,
  AssignmentGradedQuestion,
} from '@/api/types';
import { formatPoints } from '@/features/quizzes/grade';
import { getLocale, m } from '@/i18n';

/** en reads day before month, as the boards draw it ("Fri 7 Nov"). */
const dateLocale = () => (getLocale() === 'en' ? 'en-GB' : getLocale());

/** "Fri 7 Nov". */
export function dayLabel(iso: string) {
  return new Intl.DateTimeFormat(dateLocale(), {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  })
    .format(new Date(iso))
    .replace(',', '');
}

/** "24 Oct". */
export function dayMonth(iso: string) {
  return new Intl.DateTimeFormat(dateLocale(), {
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

/** "Fri 7 Nov, 18:00". */
export function dayTimeLabel(iso: string) {
  const time = new Intl.DateTimeFormat(dateLocale(), {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
  }).format(new Date(iso));
  return `${dayLabel(iso)}, ${time}`;
}

export const kindLabel = (kind: Assignment['kind']) =>
  kind === 'marked' ? m.assignment_kind_marked() : m.assignment_kind_unmarked();

export const minutesText = (count: number) =>
  count === 1 ? m.assignment_minutes_one() : m.assignment_minutes({ count });

/** "31 / 40". */
export const markText = (correct: number, total: number) =>
  `${formatPoints(correct)} / ${formatPoints(total)}`;

/** "Late −20%", or "Late" with no penalty. */
export const lateLabel = (penaltyPct: number) =>
  penaltyPct > 0
    ? m.assignment_late_penalty({ percent: penaltyPct })
    : m.assignment_late();

/** The due date's policy as sent: it goes with a marked assignment's due date,
 * and No late submissions takes no penalty. */
export function latePolicy({
  dueAt,
  kind,
  latePenaltyPct,
  noLate,
}: Pick<AssignmentFormReq, 'dueAt' | 'kind' | 'latePenaltyPct' | 'noLate'>) {
  if (kind !== 'marked' || !dueAt) return { latePenaltyPct: 0, noLate: false };
  return noLate
    ? { latePenaltyPct: 0, noLate: true }
    : { latePenaltyPct, noLate: false };
}

/** Advanced starts closed, unless a saved assignment holds something other than
 * its defaults there, so nothing is hidden by surprise. */
export const advancedStartsOpen = (
  existing?: Pick<Assignment, 'draft' | 'latePenaltyPct' | 'noLate'>
) =>
  !!existing &&
  (existing.draft || existing.noLate || existing.latePenaltyPct > 0);

const pastDue = (dueAt: string | undefined, now: number) =>
  !!dueAt && Date.parse(dueAt) <= now;

/** Closed by its own due date (No late submissions), so it can't be reopened. */
export const closedItself = (
  { dueAt, noLate }: Pick<Assignment, 'dueAt' | 'noLate'>,
  now = Date.now()
) => noLate && pastDue(dueAt, now);

/** Past its due date with late work open until an owner or TA closes it. */
export const takesLateWork = (
  {
    closedAt,
    dueAt,
    kind,
    noLate,
  }: Pick<Assignment, 'closedAt' | 'dueAt' | 'kind' | 'noLate'>,
  now = Date.now()
) => kind === 'marked' && !noLate && !closedAt && pastDue(dueAt, now);

/** The boards' "78%"; marks decided so far only. */
export const percentText = (share: number) => `${Math.round(share * 100)}%`;

export type Outcome = 'right' | 'partly' | 'wrong' | 'waiting';

export function questionOutcome(question: AssignmentGradedQuestion): Outcome {
  if (question.parts.some((part) => part.pending)) return 'waiting';
  const awarded = question.parts.reduce((n, p) => n + (p.awarded ?? 0), 0);
  const marks = question.parts.reduce((n, p) => n + p.marks, 0);
  if (awarded >= marks) return 'right';
  return awarded > 0 ? 'partly' : 'wrong';
}

export const OUTCOME_LABEL: Record<Outcome, () => string> = {
  partly: m.practice_outcome_partly,
  right: m.practice_outcome_right,
  waiting: m.assignment_not_marked,
  wrong: m.practice_outcome_wrong,
};

export const OUTCOME_SQUARE: Record<Outcome, string> = {
  partly: 'bg-solid-warning',
  right: 'bg-solid-success',
  waiting: 'bg-line-strong',
  wrong: 'bg-solid-error',
};

/** Half marks from 0 to the marks, for a mark dropdown. */
export function markSteps(marks: number) {
  return Array.from({ length: marks * 2 + 1 }, (_, i) => i / 2);
}

/** The local date input's value for an ISO time. */
export function localInputValue(iso: string, dateOnly: boolean) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly
    ? date
    : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
