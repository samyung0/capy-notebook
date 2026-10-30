import { expect, test } from 'vitest';
import { composeAnswers, extractQuestions } from './questions';

const answer = [
  'Two things first.',
  '',
  '```ask',
  '{"question": "Which one next?", "choices": ["Atomicity", "Isolation"]}',
  '{"question": "Anything to include?", "choices": []}',
  '```',
].join('\n');

test('extracts the questions of a completed answer in reading order', () => {
  expect(extractQuestions(answer)).toEqual([
    { choices: ['Atomicity', 'Isolation'], question: 'Which one next?' },
    { choices: [], question: 'Anything to include?' },
  ]);
  expect(extractQuestions('Plain prose')).toEqual([]);
});

test('keeps question shape: strings as choices, and only real questions', () => {
  expect(
    extractQuestions(
      [
        '```ask',
        '{"question": "Depth?", "choices": ["Intro", 2]}',
        '{"question": "No choices"}',
        '{"question": "  "}',
        'not json',
        '```',
      ].join('\n')
    )
  ).toEqual([
    { choices: ['Intro'], question: 'Depth?' },
    { choices: [], question: 'No choices' },
  ]);
});

test('composes answered questions into one message and drops the rest', () => {
  const questions = extractQuestions(answer);
  expect(
    composeAnswers(questions, [{ choice: 'Isolation', other: ' ' }, {}])
  ).toBe('Which one next?\nIsolation');
  expect(composeAnswers(questions, [{}, { other: 'The exam question.' }])).toBe(
    'Anything to include?\nThe exam question.'
  );
});

test('an unclosed block above the questions cannot take them', () => {
  const open = [
    '<details>',
    '<summary>More</summary>',
    '',
    'Text.',
    '',
    answer,
  ].join('\n');
  expect(extractQuestions(open).map(({ question }) => question)).toEqual([
    'Which one next?',
    'Anything to include?',
  ]);
});
