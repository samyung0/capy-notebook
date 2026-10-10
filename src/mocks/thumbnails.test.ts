import { describe, expect, it } from 'vitest';
import type { Question, QuestionAnswer } from '@/api/types';
import { questionPreview } from './thumbnails';

const question = (
  answer: QuestionAnswer,
  prompt: string,
  stem = 'Context.'
): Question => ({
  id: 'q',
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer,
      blocks: prompt ? [{ text: prompt, type: 'text' }] : [],
      id: 'q:part',
      marks: 1,
      solution: [],
    },
  ],
  stem: [{ text: stem, type: 'text' }],
});

describe('mock questionPreview (Epo 2026-10-11: no answer key in previews)', () => {
  it('sorts each matching column apart and ordering items alphabetically', () => {
    const matching = questionPreview(
      question(
        {
          options: ['Matrix', 'Cytoplasm', 'Inner membrane'],
          pairs: [
            { left: 'Krebs cycle', right: 0 },
            { left: 'Glycolysis', right: 1 },
            { left: 'ETC', right: 2 },
          ],
          type: 'matching',
        },
        'Match each stage.'
      )
    );
    expect(matching.pairs).toEqual([
      ['ETC', 'Cytoplasm'],
      ['Glycolysis', 'Inner membrane'],
      ['Krebs cycle', 'Matrix'],
    ]);
    const ordering = questionPreview(
      question(
        {
          items: [
            'Prophase',
            'Metaphase',
            'Anaphase',
            'Telophase',
            'Cytokinesis',
          ],
          type: 'ordering',
        },
        'Order the stages.'
      )
    );
    expect(ordering.items).toEqual([
      'Anaphase',
      'Cytokinesis',
      'Metaphase',
      'Prophase',
    ]);
  });

  it('takes the first part’s text as the question line, else the stem', () => {
    const boolean: QuestionAnswer = { correct: true, type: 'boolean' };
    expect(questionPreview(question(boolean, 'Is it true?')).stem).toBe(
      'Is it true?'
    );
    expect(questionPreview(question(boolean, '')).stem).toBe('Context.');
  });
});
