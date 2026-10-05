import { describe, expect, it } from 'vitest';
import { alignReveal, bankScore, filterBankRows, nextUnanswered } from './bank';
import { exampleQuestion } from './questionFixtures';
import type { LearnerQuestion, Question } from './types';

/** The learner view of a one-part question with the shown answer. */
function shownAs(
  full: Question,
  answer: LearnerQuestion['parts'][number]['answer']
): LearnerQuestion {
  const { solution: _, ...part } = full.parts[0];
  return { ...full, parts: [{ ...part, answer }] };
}

describe('bank checking', () => {
  it('keeps the shown matching letters and scores pair by pair', () => {
    const full = exampleQuestion('m', {
      options: ['A', 'B', 'C', 'Unused'],
      pairs: [
        { left: 'P1', right: 0 },
        { left: 'P2', right: 1 },
      ],
      type: 'matching',
    });
    full.parts[0].marks = 2;
    const shown = shownAs(full, {
      left: ['P1', 'P2'],
      options: ['Unused', 'B', 'A', 'C'],
      type: 'matching',
    });
    // P1 → "A" is right, P2 → "Unused" is wrong.
    const { question, answers } = alignReveal(shown, full, {
      'm-part': { 0: 2, 1: 0 },
    });
    expect(question.parts[0].answer).toMatchObject({
      options: ['Unused', 'B', 'A', 'C'],
      pairs: [
        { left: 'P1', right: 2 },
        { left: 'P2', right: 1 },
      ],
    });
    expect(bankScore(question, answers)).toBe(0.5);
  });

  it('turns a shown ordering into stored positions', () => {
    const full = exampleQuestion('o', {
      items: ['first', 'second', 'third'],
      type: 'ordering',
    });
    const shown = shownAs(full, {
      items: ['third', 'first', 'second'],
      type: 'ordering',
    });
    const right = alignReveal(shown, full, { 'o-part': [1, 2, 0] });
    expect(right.answers['o-part']).toEqual([0, 1, 2]);
    expect(bankScore(right.question, right.answers)).toBe(1);
    const wrong = alignReveal(shown, full, { 'o-part': [0, 1, 2] });
    expect(bankScore(wrong.question, wrong.answers)).toBe(0);
  });

  it('records no score for a question with open parts', () => {
    const open = exampleQuestion('x', {
      accepted: ['Evidence'],
      hints: [],
      type: 'open',
    });
    expect(bankScore(open, { 'x-part': 'Evidence' })).toBeNull();
  });
});

describe('bank progress', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({
    answerTypes: id === 'b' ? ['mcq', 'short'] : ['short'],
    id,
  }));

  it('continues after the last answered question in list order, wrapping', () => {
    expect(nextUnanswered(rows, {})).toBe('a');
    expect(nextUnanswered(rows, { a: 1, c: 0 })).toBe('d');
    expect(nextUnanswered(rows, { b: 0.5, d: 1 })).toBe('a');
    expect(nextUnanswered(rows, { a: 1, b: 1, c: 0, d: 0 })).toBeNull();
  });

  it('filters by status and answer type together', () => {
    const marks = { a: 1, b: 0.5, c: 0 };
    const ids = (types: string[], statuses: string[]) =>
      filterBankRows(rows, types, statuses, marks).map((row) => row.id);
    expect(ids([], ['correct'])).toEqual(['a']);
    expect(ids([], ['wrong', 'partial'])).toEqual(['b', 'c']);
    expect(ids([], ['notDone'])).toEqual(['d']);
    expect(ids(['mcq'], [])).toEqual(['b']);
    expect(ids(['short'], ['correct', 'notDone'])).toEqual(['a', 'd']);
  });
});
