import { expect, it } from 'vitest';
import type { AssignmentGradedQuestion } from '@/api/types';
import { m } from '@/i18n';
import { parseAssignmentsSearch } from '../studyRoutes';
import {
  advancedStartsOpen,
  closedItself,
  dayLabel,
  dayTimeLabel,
  lateLabel,
  latePolicy,
  localInputValue,
  markText,
  questionOutcome,
  takesLateWork,
  typedMark,
} from './assignmentText';
import { questionsWithNoAnswers } from './NoAnswersWarning';

const graded = (
  parts: { marks: number; awarded?: number; pending?: boolean }[]
) => ({ parts }) as unknown as AssignmentGradedQuestion;

it('reads a question as right, partly, wrong or waiting', () => {
  expect(questionOutcome(graded([{ awarded: 2, marks: 2 }]))).toBe('right');
  expect(questionOutcome(graded([{ awarded: 1, marks: 2 }]))).toBe('partly');
  expect(questionOutcome(graded([{ awarded: 0, marks: 2 }]))).toBe('wrong');
  // A waiting part holds the whole question back, whatever else it earned.
  expect(
    questionOutcome(
      graded([
        { awarded: 1, marks: 1 },
        { awarded: 0, marks: 2, pending: true },
      ])
    )
  ).toBe('waiting');
});

it('keeps a typed mark to one decimal place within the marks', () => {
  expect(typedMark('1.', 2)).toBe('1.');
  expect(typedMark('1,5', 2)).toBe('1.5');
  expect(typedMark('1.55', 2)).toBeUndefined();
  expect(typedMark('2.1', 2)).toBeUndefined();
  expect(typedMark('-1', 2)).toBeUndefined();
});

it('writes a mark out of the marks', () => {
  expect(markText(2.5, 6)).toBe('2.5 / 6');
  expect(markText(0.1 + 0.2, 1)).toBe('0.3 / 1');
});

it('draws dates as the boards do', () => {
  const iso = new Date(2026, 10, 7, 18, 0).toISOString();
  expect(dayLabel(iso)).toBe('Sat 7 Nov');
  expect(dayTimeLabel(iso)).toBe('Sat 7 Nov, 18:00');
  expect(localInputValue(iso, true)).toBe('2026-11-07');
  expect(localInputValue(iso, false)).toBe('2026-11-07T18:00');
});

it('keeps each report link in the URL', () => {
  const parse = parseAssignmentsSearch;
  expect(parse({ tab: 'members' }).tab).toBe(undefined);
  expect(parse({ assignment: 'as1', tab: 'members' })).toMatchObject({
    assignment: 'as1',
    tab: 'members',
  });
  expect(
    parse({
      assignment: 'as1',
      member: 'u1',
      question: 'q3',
      tab: 'grading',
    })
  ).toMatchObject({ member: 'u1', question: 'q3', tab: 'grading' });
  expect(
    parse({
      assignment: 'as1',
      by: 'question',
      tab: 'responses',
    })
  ).toMatchObject({ by: 'question', tab: 'responses' });
  expect(parse({ assignment: 'as1', attempt: 'at1' })).toMatchObject({
    assignment: 'as1',
    attempt: 'at1',
  });
  // Opened from a member's profile: the profile to go back to.
  expect(
    parse({
      assignment: 'as1',
      attempt: 'at1',
      member: 'u1',
      show: 'topics',
    })
  ).toMatchObject({ member: 'u1', show: 'topics' });
  // Grading's member and file (Epo 2026-11-19).
  expect(
    parse({ assignment: 'as1', member: 'u1', tab: 'grading', work: 'f1' })
  ).toMatchObject({ member: 'u1', tab: 'grading', work: 'f1' });
  expect(
    parse({ assignment: 'as1', fullscreen: 'true', tab: 'grading' }).fullscreen
  ).toBe(true);
  // Questions' too, which as the first tab has no `tab` in its URL.
  expect(parse({ assignment: 'as1', fullscreen: 'true' }).fullscreen).toBe(
    true
  );
  // An unknown tab clears, and a question only belongs to Grading.
  expect(parse({ assignment: 'as1', tab: 'x' }).tab).toBe(undefined);
  expect(parse({ assignment: 'as1', question: 'q3' }).question).toBe(undefined);
});

it('sends the due date policy only with a marked due date', () => {
  const dueAt = '2026-11-07T18:00:00Z';
  const marked = { dueAt, kind: 'marked' as const };
  expect(latePolicy({ ...marked, latePenaltyPct: 20, noLate: false })).toEqual({
    latePenaltyPct: 20,
    noLate: false,
  });
  // The switch on takes no penalty, whatever the hidden select held.
  expect(latePolicy({ ...marked, latePenaltyPct: 20, noLate: true })).toEqual({
    latePenaltyPct: 0,
    noLate: true,
  });
  const none = { latePenaltyPct: 0, noLate: false };
  expect(
    latePolicy({ kind: 'marked', latePenaltyPct: 50, noLate: true })
  ).toEqual(none);
  // Either kind closes at its due date; only a marked one takes a penalty.
  expect(
    latePolicy({ dueAt, kind: 'unmarked', latePenaltyPct: 0, noLate: true })
  ).toEqual({ latePenaltyPct: 0, noLate: true });
  expect(
    latePolicy({ dueAt, kind: 'unmarked', latePenaltyPct: 50, noLate: false })
  ).toEqual(none);
});

it('tells late work open from closed by its own due date', () => {
  const dueAt = '2026-11-07T18:00:00Z';
  const after = Date.parse(dueAt) + 1000;
  const before = Date.parse(dueAt) - 1000;
  const noLate = { dueAt, noLate: true };
  const late = { dueAt, noLate: false };
  expect(closedItself(noLate, after)).toBe(true);
  expect(closedItself(noLate, before)).toBe(false);
  expect(closedItself(late, after)).toBe(false);
  expect(takesLateWork(late, after)).toBe(true);
  expect(takesLateWork(late, before)).toBe(false);
  expect(takesLateWork(noLate, after)).toBe(false);
  expect(takesLateWork({ ...late, closedAt: dueAt }, after)).toBe(false);
});

it('names the penalty on late work', () => {
  expect(lateLabel(20)).toBe(m.assignment_late_penalty({ percent: 20 }));
  expect(lateLabel(0)).toBe(m.assignment_late());
});

it('opens Advanced only for what a saved assignment holds there', () => {
  const plain = { draft: false, latePenaltyPct: 0, noLate: false };
  expect(advancedStartsOpen()).toBe(false);
  expect(advancedStartsOpen(plain)).toBe(false);
  expect(advancedStartsOpen({ ...plain, draft: true })).toBe(true);
  expect(advancedStartsOpen({ ...plain, noLate: true })).toBe(true);
  expect(advancedStartsOpen({ ...plain, latePenaltyPct: 20 })).toBe(true);
});

it('counts the questions a room holds that the quiz does not project', () => {
  const q = (id: string) => ({ id });
  expect(questionsWithNoAnswers([q('a'), q('b'), q('c')], [q('b')])).toBe(2);
});
