import { expect, it } from 'vitest';
import type { AssignmentGradedQuestion } from '@/api/types';
import { parseWorkspaceOpenSearch } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { materialCanClone } from '@/features/files/fileUtils';
import {
  closedItself,
  dayLabel,
  dayTimeLabel,
  lateLabel,
  latePolicy,
  localInputValue,
  markSteps,
  markText,
  questionOutcome,
  takesLateWork,
} from './assignmentText';
import { paperMeta } from './useAssignmentStart';

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

it('offers half marks up to the marks', () => {
  expect(markSteps(2)).toEqual([0, 0.5, 1, 1.5, 2]);
  expect(markText(2.5, 6)).toBe('2.5 / 6');
});

it('draws dates as the boards do', () => {
  const iso = new Date(2026, 10, 7, 18, 0).toISOString();
  expect(dayLabel(iso)).toBe('Sat 7 Nov');
  expect(dayTimeLabel(iso)).toBe('Sat 7 Nov, 18:00');
  expect(localInputValue(iso, true)).toBe('2026-11-07');
  expect(localInputValue(iso, false)).toBe('2026-11-07T18:00');
});

it('sizes a paper in the words of Before you start', () => {
  expect(paperMeta({ marks: 40, questions: 12 })).toBe(
    `${m.question_ui_question_count({ count: 12 })} · ${m.question_ui_marks({ count: 40 })}`
  );
});

it('keeps each report link in the URL', () => {
  const parse = parseWorkspaceOpenSearch;
  expect(parse({ study: 'assignments' }).study).toBe('assignments');
  expect(
    parse({ assignment: 'as1', study: 'assignments', tab: 'members' })
  ).toMatchObject({ assignment: 'as1', tab: 'members' });
  expect(
    parse({
      assignment: 'as1',
      member: 'u1',
      question: 'q3',
      study: 'assignments',
      tab: 'approve',
    })
  ).toMatchObject({ member: 'u1', question: 'q3', tab: 'approve' });
  expect(
    parse({ assignment: 'as1', attempt: 'at1', study: 'assignments' })
  ).toMatchObject({ assignment: 'as1', attempt: 'at1' });
  // An unknown tab clears, and a question only belongs to Approve AI marks.
  expect(parse({ assignment: 'as1', study: 'assignments', tab: 'x' }).tab).toBe(
    undefined
  );
  expect(
    parse({ assignment: 'as1', question: 'q3', study: 'assignments' }).question
  ).toBe(undefined);
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
  expect(
    latePolicy({ dueAt, kind: 'unmarked', latePenaltyPct: 50, noLate: true })
  ).toEqual(none);
});

it('tells late work open from closed by its own due date', () => {
  const dueAt = '2026-11-07T18:00:00Z';
  const after = Date.parse(dueAt) + 1000;
  const before = Date.parse(dueAt) - 1000;
  const noLate = { dueAt, kind: 'marked' as const, noLate: true };
  const late = { dueAt, kind: 'marked' as const, noLate: false };
  expect(closedItself(noLate, after)).toBe(true);
  expect(closedItself(noLate, before)).toBe(false);
  expect(closedItself(late, after)).toBe(false);
  expect(takesLateWork(late, after)).toBe(true);
  expect(takesLateWork(late, before)).toBe(false);
  expect(takesLateWork(noLate, after)).toBe(false);
  expect(takesLateWork({ ...late, closedAt: dueAt }, after)).toBe(false);
  expect(takesLateWork({ ...late, kind: 'unmarked' }, after)).toBe(false);
});

it('names the penalty on late work', () => {
  expect(lateLabel(20)).toBe(m.assignment_late_penalty({ percent: 20 }));
  expect(lateLabel(0)).toBe(m.assignment_late());
});

it('offers an assigned quiz to clone to staff alone', () => {
  const linkEditor = { canClone: true, role: undefined };
  expect(materialCanClone(linkEditor)).toBe(true);
  expect(materialCanClone(linkEditor, true)).toBe(false);
  expect(materialCanClone({ canClone: true, role: 'editor' }, true)).toBe(true);
  expect(materialCanClone({ canClone: true, role: 'owner' }, true)).toBe(true);
  expect(materialCanClone({ canClone: false, role: 'viewer' })).toBe(false);
});
