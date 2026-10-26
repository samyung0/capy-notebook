import { expect, it } from 'vitest';
import { exampleQuestion } from './questionFixtures';
import { withGapsText, withoutGapsBlock } from './types';

it('keeps each blank with its answers as a text gains a blank', () => {
  const question = exampleQuestion('gaps', {
    accepted: [['100'], ['0']],
    type: 'gaps',
  });
  const part = {
    ...question.parts[0],
    blocks: [
      { text: 'Boils at (1) ______.', type: 'text' as const },
      { text: 'Freezes at (2) ______.', type: 'text' as const },
    ],
  };
  const next = withGapsText(
    part,
    0,
    'Melts at (1) ______, boils at (2) ______.',
    [[''], ['100']]
  );
  expect(next.blocks).toEqual([
    { text: 'Melts at (1) ______, boils at (2) ______.', type: 'text' },
    { text: 'Freezes at (3) ______.', type: 'text' },
  ]);
  expect(next.answer).toMatchObject({ accepted: [[''], ['100'], ['0']] });
});

it('drops a removed text block with its blanks and their answers, renumbering the rest', () => {
  const question = exampleQuestion('gaps', {
    accepted: [['100'], ['0']],
    type: 'gaps',
  });
  const part = {
    ...question.parts[0],
    blocks: [
      { text: 'Boils at (1) ______.', type: 'text' as const },
      { text: 'Freezes at (2) ______.', type: 'text' as const },
    ],
  };
  const next = withoutGapsBlock(part, 0);
  expect(next.blocks).toEqual([
    { text: 'Freezes at (1) ______.', type: 'text' },
  ]);
  expect(next.answer).toMatchObject({ accepted: [['0']] });
});
