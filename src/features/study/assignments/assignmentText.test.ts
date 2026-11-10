import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { dateLabel, dueText, timeLabel } from './assignmentText';

// Epo 2026-11-10: a quiz closing in an hour reads apart from one due tonight.
it('shows today and tomorrow with the time, past due as Overdue', () => {
  const now = new Date(2026, 10, 10, 14, 0);
  const at = (day: number, hour: number) =>
    new Date(2026, 10, day, hour, 30).toISOString();
  expect(dueText(at(10, 15), false, now)).toEqual({
    text: m.todo_due_today({ time: timeLabel(at(10, 15)) }),
    tone: 'soon',
  });
  expect(dueText(at(11, 9), false, now).text).toBe(
    m.todo_due_tomorrow({ time: timeLabel(at(11, 9)) })
  );
  expect(dueText(at(18, 9), false, now).text).toBe(dateLabel(at(18, 9)));
  expect(dueText(at(9, 9), false, now)).toEqual({
    text: m.todo_overdue({ date: dateLabel(at(9, 9)) }),
    tone: 'overdue',
  });
  // Ticked, a past due date is only its date.
  expect(dueText(at(9, 9), true, now).text).toBe(dateLabel(at(9, 9)));
  expect(dueText(undefined, false, now).text).toBe(m.todo_no_due());
});
