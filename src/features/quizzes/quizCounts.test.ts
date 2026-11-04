import { describe, expect, it } from 'vitest';
import type { Question } from '@/api/types';
import { m } from '@/i18n';
import { aiMarkedCount } from './QuizEditor';

const part = (type: 'mcq' | 'open') =>
  ({
    answer:
      type === 'open'
        ? { accepted: [], hints: [], type }
        : { correct: [0], options: ['a', 'b'], type },
    blocks: [{ text: 'Q', type: 'text' }],
    id: `p_${type}`,
    marks: 1,
    solution: [],
  }) as Question['parts'][number];

describe('the quiz editor counts', () => {
  it('names the AI-marked parts against the cap', () => {
    const questions = [
      {
        id: 'q1',
        labels: 'letters',
        layout: 'paper',
        parts: [part('open'), part('mcq')],
        stem: [],
      },
      {
        id: 'q2',
        labels: 'letters',
        layout: 'paper',
        parts: [part('open')],
        stem: [],
      },
    ] as Question[];
    expect(aiMarkedCount(questions)).toBe(
      m.quiz_ai_marked_count({ count: 2, max: 100 })
    );
  });
});
