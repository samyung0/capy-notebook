import { expect, test } from 'vitest';
import type { Question } from '@/features/questions/types';
import { questionSummary } from './QuizSplit';

const withText = (text: string) =>
  ({ parts: [], stem: [{ text, type: 'text' }] }) as unknown as Question;

test('a row reads without formula markup', () => {
  expect(questionSummary(withText('A side of $L=2$ cm'))).toBe(
    'A side of L=2 cm'
  );
  expect(questionSummary(withText('Find $\\frac{1}{2}x$ here'))).toBe(
    'Find … here'
  );
});
