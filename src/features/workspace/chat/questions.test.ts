import { expect, test } from 'vitest';
import { extractQuestions } from './questions';

// The pipeline lists AskUsers root left out in a later root line (Epo
// 2026-10-29); the browser's parser must take that later root.
test('a later root line brings in the questions the first left out', () => {
  const program = [
    'root = Answer([intro, ask])',
    'intro = Md("Two things first.")',
    'ask = AskUser("Two quick choices:", [])',
    'ask1 = AskUser("What level?", ["Beginner", "Undergraduate"])',
    'root = Answer([intro, ask, ask1])',
  ].join('\n');
  expect(extractQuestions(program)).toEqual([
    { choices: [], question: 'Two quick choices:' },
    { choices: ['Beginner', 'Undergraduate'], question: 'What level?' },
  ]);
});
