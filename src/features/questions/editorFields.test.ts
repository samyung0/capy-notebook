import type { KeyboardEvent } from 'react';
import { expect, it, vi } from 'vitest';
import {
  answerKind,
  answerOfKind,
  moveColumn,
  moveItems,
  moveKeys,
  moveRow,
  withShuffle,
} from './editorFields';
import type { QuestionAnswer } from './types';

const choices: Extract<QuestionAnswer, { type: 'mcq' }> = {
  correct: [2, 0],
  options: ['Nucleus', 'Ribosome', 'Mitochondrion'],
  type: 'mcq',
};

it('reads several correct options, or the flag, as Multiple answer', () => {
  expect(answerKind(choices)).toBe('multiple');
  expect(answerKind({ ...choices, correct: [1], multiple: true })).toBe(
    'multiple'
  );
  expect(answerKind({ ...choices, correct: [1] })).toBe('mcq');
});

it('turns Multiple choice into Multiple answer keeping the options', () => {
  expect(answerOfKind({ ...choices, correct: [1] }, 'multiple')).toEqual({
    correct: [1],
    multiple: true,
    options: choices.options,
    type: 'mcq',
  });
});

it('keeps only the first correct option for Multiple choice', () => {
  expect(answerOfKind({ ...choices, multiple: true }, 'mcq')).toEqual({
    correct: [0],
    options: choices.options,
    type: 'mcq',
  });
});

/** A key press on a row's input, inside no list. */
const press = (key: string, altKey = true) =>
  ({
    altKey,
    currentTarget: { closest: () => null },
    key,
    preventDefault: vi.fn(),
  }) as unknown as KeyboardEvent<HTMLInputElement>;

it('moves the focused row with Alt+ArrowUp and Alt+ArrowDown', () => {
  const onMove = vi.fn();
  moveKeys(1, 3, onMove)(press('ArrowDown'));
  moveKeys(1, 3, onMove)(press('ArrowUp'));
  expect(onMove.mock.calls).toEqual([
    [1, 2],
    [1, 0],
  ]);
});

it('moves a matching column, the correct cells following their column', () => {
  const matching = {
    options: ['Stores DNA', 'Makes ATP', 'Builds proteins'],
    pairs: [
      { left: 'Nucleus', right: 0 },
      { left: 'Mitochondrion', right: 1 },
      { left: 'Ribosome', right: 2 },
    ],
    type: 'matching' as const,
  };
  expect(moveColumn(matching, 0, 2)).toEqual({
    ...matching,
    options: ['Makes ATP', 'Builds proteins', 'Stores DNA'],
    pairs: [
      { left: 'Nucleus', right: 2 },
      { left: 'Mitochondrion', right: 0 },
      { left: 'Ribosome', right: 1 },
    ],
  });
  expect(moveRow(matching, 2, 0).pairs).toEqual([
    { left: 'Ribosome', right: 2 },
    { left: 'Nucleus', right: 0 },
    { left: 'Mitochondrion', right: 1 },
  ]);
});

it('moves ordering items', () => {
  expect(
    moveItems(
      { items: ['Prophase', 'Metaphase', 'Anaphase'], type: 'ordering' },
      2,
      0
    )
  ).toEqual({ items: ['Anaphase', 'Prophase', 'Metaphase'], type: 'ordering' });
});

it('turns Shuffle options off dropping its locked options', () => {
  const shuffled = withShuffle({ ...choices, correct: [1] }, true);
  expect(shuffled.shuffle).toBe(true);
  expect(withShuffle({ ...shuffled, locked: [2] }, false)).toEqual({
    ...choices,
    correct: [1],
  });
});
