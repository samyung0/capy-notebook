import { describe, expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { answerKey, applyOpenAward, fuzzyMatch, scoreQuestion } from './grade';
import { blocksToText } from './scoreAttempt';

describe('part grading', () => {
  it('derives marks from scheme items and uses stable part IDs', () => {
    const question = exampleQuestion('q');
    question.parts[0].markscheme.push('Provides supporting evidence.');
    expect(scoreQuestion(question, answerKey(question))).toEqual({
      awarded: 2,
      max: 2,
    });
    expect(scoreQuestion(question, { q: [1] })).toEqual({ awarded: 0, max: 2 });
    const open = exampleQuestion('open', {
      accepted: ['Evidence'],
      hints: [],
      type: 'open',
    });
    open.parts[0] = applyOpenAward(open.parts[0], 0.5, 'Partly correct.');
    expect(scoreQuestion(open, {})).toEqual({ awarded: 0.5, max: 1 });
  });
  it('retains unused and reused matching choices without matching by label', () => {
    const question = exampleQuestion('matching', {
      options: ['same', 'same', 'distractor'],
      pairs: [
        { left: 'A', right: 1 },
        { left: 'A', right: 1 },
      ],
      type: 'matching',
    });
    expect(scoreQuestion(question, answerKey(question)).awarded).toBe(1);
    expect(
      scoreQuestion(question, { 'matching-part': { 0: 0, 1: 1 } }).awarded
    ).toBe(0);
  });
  it('keeps signs and decimals, rejects typed units, and never converts units', () => {
    expect(fuzzyMatch('-25', '25')).toBe(false);
    expect(fuzzyMatch('1.25', '125')).toBe(false);
    expect(fuzzyMatch('photosynthesis', 'photosyntheis')).toBe(true);
    const question = exampleQuestion('quantity', {
      accepted: ['-1.25'],
      type: 'short',
      unit: 'm',
    });
    expect(scoreQuestion(question, { 'quantity-part': '-1.25' }).awarded).toBe(
      1
    );
    for (const answer of ['1.25', '-125', '-125 cm', '-1.25 m'])
      expect(scoreQuestion(question, { 'quantity-part': answer }).awarded).toBe(
        0
      );
  });
  it('keeps figures, table cells, and chart data in the text grading context', () => {
    expect(
      blocksToText([
        {
          description: 'A increases while B falls.',
          height: 100,
          image: { url: 'https://example.invalid/figure.png' },
          type: 'image',
          width: 100,
        },
        { header: false, rows: [['A', '2']], type: 'table' },
        {
          kind: 'bar',
          labels: ['May'],
          series: [{ name: 'A', values: [12] }],
          title: 'Growth',
          type: 'chart',
        },
      ])
    ).toContain('A increases while B falls.');
  });
  it('compares decimal, fraction and scientific quantities without rounding', () => {
    const check = (accepted: string, entered: string) =>
      scoreQuestion(
        exampleQuestion('exact', {
          accepted: [accepted],
          type: 'short',
          unit: 'm',
        }),
        { 'exact-part': entered }
      ).awarded;
    expect(check('9007199254740992', '9007199254740993')).toBe(0);
    expect(check('1e-400', '0')).toBe(0);
    expect(check('1e400', '1e401')).toBe(0);
    expect(check('1.25', '5/4')).toBe(1);
    expect(check('-1.25', '5/-4')).toBe(1);
    expect(check('1e400', '10e399')).toBe(1);
    expect(check('0', '-0.000')).toBe(1);
    expect(check('0', '0/0')).toBe(0);
  });
});
