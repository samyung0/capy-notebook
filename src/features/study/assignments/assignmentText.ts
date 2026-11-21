import type {
  Assignment,
  AssignmentFile,
  AssignmentFormReq,
  AssignmentGradedQuestion,
} from '@/api/types';
import { fullPartLabel } from '@/features/questions/groups';
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

/** "11 Nov 2026": the To do page's dates, with the year and no weekday
 * (Epo 2026-11-10). */
export function dateLabel(iso: string) {
  return new Intl.DateTimeFormat(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

/** "11 Nov 2026, 09:00". */
export const dateTimeLabel = (iso: string) =>
  `${dateLabel(iso)}, ${timeLabel(iso)}`;

/** "Mon". */
export function weekdayLabel(iso: string) {
  return new Intl.DateTimeFormat(dateLocale(), { weekday: 'short' }).format(
    new Date(iso)
  );
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
  return `${dayLabel(iso)}, ${timeLabel(iso)}`;
}

/** "18:00". */
export const timeLabel = (iso: string) =>
  new Intl.DateTimeFormat(dateLocale(), {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
  }).format(new Date(iso));

const dayStart = (at: Date) =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** A To do row's due date (Epo 2026-11-10): today and tomorrow with the time,
 * past it Overdue unless ticked, otherwise the date. */
export function dueText(
  dueAt: string | undefined,
  ticked: boolean,
  now = new Date()
): string {
  if (!dueAt) return m.todo_no_due();
  const due = new Date(dueAt);
  if (!ticked && due.getTime() <= now.getTime())
    return m.todo_overdue({ date: dateLabel(dueAt) });
  const days = Math.round((dayStart(due) - dayStart(now)) / 86_400_000);
  if (days === 0) return m.todo_due_today({ time: timeLabel(dueAt) });
  if (days === 1) return m.todo_due_tomorrow({ time: timeLabel(dueAt) });
  return dateLabel(dueAt);
}

/** A graded quiz, else an Assignment in a class and a Task one set oneself
 * (Epo 2026-11-14). */
export const kindLabel = ({ kind }: Pick<Assignment, 'kind'>) =>
  kind === 'marked'
    ? m.assignment_kind_marked()
    : m.assignment_kind_assignment();

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

/** The due date's policy as sent: it goes with a due date, and No late
 * submissions takes no penalty. */
export function latePolicy({
  dueAt,
  kind,
  latePenaltyPct,
  noLate,
  points,
}: Pick<
  AssignmentFormReq,
  'dueAt' | 'kind' | 'latePenaltyPct' | 'noLate' | 'points'
>) {
  if (!dueAt) return { latePenaltyPct: 0, noLate: false };
  if (noLate) return { latePenaltyPct: 0, noLate: true };
  // Only marks or a grade take a penalty.
  return {
    latePenaltyPct: isGraded({ kind, points }) ? latePenaltyPct : 0,
    noLate,
  };
}

/** A graded quiz, or an Assignment graded on points (Epo 2026-11-14): what
 * has marks, Show grades and a late penalty. */
export const isGraded = ({
  kind,
  points,
}: {
  kind: Assignment['kind'];
  points?: number;
}) => kind === 'marked' || points !== undefined;

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
    noLate,
  }: Pick<Assignment, 'closedAt' | 'dueAt' | 'noLate'>,
  now = Date.now()
) => !noLate && !closedAt && pastDue(dueAt, now);

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

/** The local date input's value for an ISO time. */
export function localInputValue(iso: string, dateOnly: boolean) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly
    ? date
    : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What closing a marked assignment does, one line each, for its confirm:
 * the due date it cuts short (`early`, drawn as a warning), who can no longer
 * submit, answers it releases and grades held. A graded quiz's quiz stays
 * held either way (Epo 2026-11-14). */
export function closeOutcomes(
  assignment: Pick<Assignment, 'dueAt' | 'manage'>,
  now = Date.now()
): { early?: true; text: string }[] {
  const { dueAt, manage } = assignment;
  const gradesHeld =
    manage?.showGrades === 'manual' && !manage.gradesReleasedAt;
  const left = (manage?.assigned ?? 0) - (manage?.done ?? 0);
  const answers =
    manage &&
    {
      closed: gradesHeld
        ? m.assignment_close_answers_after_release()
        : m.assignment_close_answers_shown(),
      never: m.assignment_close_answers_hidden(),
      // Shown at submit already: closing changes nothing there.
      submitted: null,
    }[manage.showAnswers];
  const early = !!dueAt && !pastDue(dueAt, now);
  return [
    dueAt &&
      (early
        ? m.assignment_close_early({ date: dayTimeLabel(dueAt) })
        : m.assignment_close_late_ends()),
    left > 0 &&
      m.assignment_close_unsubmitted({ count: left, total: manage?.assigned }),
    answers,
    gradesHeld && m.assignment_close_grades_held(),
  ]
    .filter((text): text is string => !!text)
    .map((text, index) =>
      index === 0 && early ? { early: true, text } : { text }
    );
}

const MARK_TEXT = /^\d*(\.\d?)?$/;

/** A mark field's next text, or undefined to refuse the key: digits with at
 * most one decimal place (a decimal comma reads as a point), from 0 to
 * `max`. "1." stays as typed, on its way to 1.5. */
export function typedMark(text: string, max: number): string | undefined {
  const next = text.trim().replace(',', '.');
  if (!MARK_TEXT.test(next)) return;
  return next === '' || next === '.' || Number(next) <= max
    ? next === '.'
      ? '0.'
      : next
    : undefined;
}

/** A question's row name, or one of its parts' when a question of several
 * parts lays each out as its own row (the report's Questions tab, a
 * member's result): "Q18", "Q18 (a)(i)", and with number labels "Q19 (2)"
 * (Epo 2026-11-19, not "Q19.2"). */
export function questionRowName(
  number: number,
  question?: Parameters<typeof fullPartLabel>[0],
  partId?: string
) {
  const label = question && partId ? fullPartLabel(question, partId) : '';
  if (!label) return `Q${number}`;
  if (label.startsWith('(')) return `Q${number} ${label}`;
  // "2." or "2(i)": the number in brackets as letters are.
  const [, top, rest] = NUMBER_LABEL.exec(label) ?? [];
  return top ? `Q${number} (${top})${rest}` : `Q${number} ${label}`;
}
const NUMBER_LABEL = /^(\d+)\.?(.*)$/;

/** A file's graded quiz's question paper (Epo 2026-11-20): its one file, or
 * null once the caller can no longer open it (trashed, hidden from members).
 * Undefined for any other assignment. */
export function questionPaperOf(
  assignment: Pick<Assignment, 'files' | 'paperFile'> | undefined
): AssignmentFile | null | undefined {
  if (!assignment?.paperFile) return;
  return assignment.files.find((file) => file.fileId) ?? null;
}
