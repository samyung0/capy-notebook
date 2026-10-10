import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { outcomeOf, type QuestionResult, ResultSquares } from './ResultSummary';

const result = (
  number: number,
  awarded: number | null,
  marks = 2
): QuestionResult => ({
  awarded,
  id: `q${number}`,
  marks,
  number,
  type: 'short',
});

it('colours each question by its marks and counts only the colours present', () => {
  const results = [result(1, 2), result(2, 1), result(3, 0), result(4, 2)];
  expect(results.map(outcomeOf)).toEqual(['full', 'partial', 'wrong', 'full']);
  expect(outcomeOf(result(5, null))).toBe('none');

  const html = renderToStaticMarkup(<ResultSquares results={results} />);
  expect(html).toContain(m.quiz_question_partial({ number: 2 }));
  expect(html).toContain(m.result_full({ count: 2 }));
  expect(html).toContain(m.result_wrong({ count: 1 }));
  expect(html).not.toContain(m.result_unanswered({ count: 0 }));
});
