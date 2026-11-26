import { expect, it } from 'vitest';
import type { Assignment } from '@/api/types';
import { m } from '@/i18n';
import {
  averageTone,
  closeOutcomes,
  dateLabel,
  dayTimeLabel,
  dueText,
  latePolicy,
  startsLeft,
  timeLabel,
} from './assignmentText';

// Epo 2026-11-10: a quiz closing in an hour reads apart from one due tonight.
it('shows today and tomorrow with the time, past due as Overdue', () => {
  const now = new Date(2026, 10, 10, 14, 0);
  const at = (day: number, hour: number) =>
    new Date(2026, 10, day, hour, 30).toISOString();
  expect(dueText(at(10, 15), false, now)).toBe(
    m.todo_due_today({ time: timeLabel(at(10, 15)) })
  );
  expect(dueText(at(11, 9), false, now)).toBe(
    m.todo_due_tomorrow({ time: timeLabel(at(11, 9)) })
  );
  expect(dueText(at(18, 9), false, now)).toBe(dateLabel(at(18, 9)));
  expect(dueText(at(9, 9), false, now)).toBe(
    m.todo_overdue({ date: dateLabel(at(9, 9)) })
  );
  // Ticked, a past due date is only its date.
  expect(dueText(at(9, 9), true, now)).toBe(dateLabel(at(9, 9)));
  expect(dueText(undefined, false, now)).toBe(m.todo_no_due());
});

// Epo 2026-11-14: the close confirm lists what closing does.
it('lists what closing does to a marked assignment', () => {
  const now = Date.parse('2026-11-14T10:00:00Z');
  const dueAt = '2026-11-16T18:00:00Z';
  const early = closeOutcomes(
    {
      dueAt,
      manage: {
        assigned: 20,
        done: 17,
        showAnswers: 'closed',
        showGrades: 'automatic',
      } as unknown as Assignment['manage'],
    },
    now
  );
  expect(early).toEqual([
    {
      early: true,
      text: m.assignment_close_early({ date: dayTimeLabel(dueAt) }),
    },
    { text: m.assignment_close_unsubmitted({ count: 3, total: 20 }) },
    { text: m.assignment_close_answers_shown() },
  ]);
  // Past due with Do not show and grades held: late work ends, all stays held.
  const held = closeOutcomes(
    {
      dueAt: '2026-11-10T18:00:00Z',
      manage: {
        assigned: 5,
        done: 5,
        showAnswers: 'never',
        showGrades: 'manual',
      } as unknown as Assignment['manage'],
    },
    now
  );
  expect(held.map(({ text }) => text)).toEqual([
    m.assignment_close_late_ends(),
    m.assignment_close_answers_hidden(),
    m.assignment_close_grades_held(),
  ]);
});

// Epo 2026-11-14: a graded Assignment's grade takes the late penalty as a
// graded quiz's marks do; an ungraded one has nothing to take it from.
it('keeps the late penalty only on what is graded', () => {
  const policy = {
    dueAt: '2026-12-01T10:00:00Z',
    latePenaltyPct: 20,
    noLate: false,
  };
  expect(latePolicy({ ...policy, kind: 'marked' }).latePenaltyPct).toBe(20);
  expect(
    latePolicy({ ...policy, kind: 'unmarked', points: 20 }).latePenaltyPct
  ).toBe(20);
  expect(latePolicy({ ...policy, kind: 'unmarked' }).latePenaltyPct).toBe(0);
});

// Epo 2026-11-22: a report's averages tinted by the topic labels' thresholds.
it("tints an average by its band, none before it's marked", () => {
  expect(averageTone(0.7)).toBe('success');
  expect(averageTone(0.65)).toBe('warning');
  expect(averageTone(0.59)).toBe('error');
  expect(averageTone(undefined)).toBeUndefined();
});

// Epo 2026-11-25: the first start picks the way; an upload is handed in once.
it('keeps a member to the way they first answered', () => {
  const mine = (attemptsUsed: number, paperHandedIn: boolean) =>
    ({ attemptsUsed, paperHandedIn }) as Assignment['mine'];
  const both = { allowUploads: true, attempts: 3, uploadOnly: false };
  expect(startsLeft({ ...both, mine: mine(0, false) })).toEqual({
    online: true,
    upload: true,
  });
  expect(startsLeft({ ...both, mine: mine(1, false) })).toEqual({
    online: true,
    upload: false,
  });
  expect(startsLeft({ ...both, mine: mine(0, true) })).toEqual({
    online: false,
    upload: false,
  });
});
