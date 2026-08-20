import { describe, expect, it } from 'vitest';
import type { Question } from '@/api/types';
import {
  applyOpenAward,
  formatPoints,
  questionPoints,
  scoreQuestion,
  sumScores,
} from './grade';

const mcq: Question = {
  correct: [0],
  id: 'mcq',
  level: 'recall',
  options: [{ value: 'A' }, { value: 'B' }],
  prompt: 'Pick',
  type: 'mcq',
};

const open: Question = {
  accepted: [{ value: 'Cristae increase surface area.' }],
  hints: [{ value: 'ATP' }],
  id: 'open',
  level: 'application',
  prompt: 'Why folded?',
  rubrics: [{ value: 'Mentions folds' }],
  type: 'open',
};

describe('quiz points', () => {
  it('defaults each question to 1 point and snaps half-points', () => {
    expect(questionPoints(mcq)).toBe(1);
    expect(questionPoints({ points: 2 })).toBe(2);
    expect(questionPoints({ points: 0.5 })).toBe(0.5);
    expect(questionPoints({ points: 1.25 })).toBe(1.5);
    expect(questionPoints({ points: 0 })).toBe(1);
    expect(formatPoints(2.5)).toBe('2.5');
    expect(formatPoints(3)).toBe('3');
  });

  it('scores closed questions as all or nothing', () => {
    expect(scoreQuestion(mcq, [0])).toEqual({ awarded: 1, max: 1 });
    expect(scoreQuestion(mcq, [1])).toEqual({ awarded: 0, max: 1 });
    expect(scoreQuestion({ ...mcq, points: 2 }, [0])).toEqual({
      awarded: 2,
      max: 2,
    });
  });

  it('scales an open award by the question points', () => {
    const half = applyOpenAward({ ...open, points: 2 }, 0.5, 'partial');
    expect(half.awarded).toBe(1);
    expect(half.awardReason).toBe('partial');
    expect(scoreQuestion(half, 'whatever')).toEqual({ awarded: 1, max: 2 });
  });

  it('sums an attempt in points, not question counts', () => {
    const total = sumScores([
      scoreQuestion(mcq, [0]),
      scoreQuestion(applyOpenAward(open, 0.5), 'partial'),
    ]);
    expect(total).toEqual({ awarded: 1.5, max: 2 });
  });
});
