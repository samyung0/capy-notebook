import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { learnerView } from '@/mocks/answerKeys';
import { exampleQuestion } from './questionFixtures';
import {
  gapListsByBlock,
  partAnswerCanvas,
  type Question,
  withGapsBlocks,
  withGapsText,
  withoutGapsBlock,
} from './types';

const fixture = (name: string): Question =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../server/internal/questions/testdata/${name}.json`,
        import.meta.url
      ),
      'utf8'
    )
  ).question;

// A canvas part answers in its own canvas or, shared, the nearest one above:
// its group's, else the stem's, never its own (Epo 2026-11-23); a learner's
// question reads the same. Go's TestPartAnswerCanvas is the same.
it('finds the canvas a part answers in', () => {
  const at = (question: Question, part: number) =>
    [question, learnerView(question)].map((view) => {
      const found = partAnswerCanvas(view, view.parts[part]);
      return found && { index: found.index, place: found.place };
    });
  const both = <T>(value: T) => [value, value];
  const group = fixture('canvas-shared-group');
  expect(at(group, 0)).toEqual(
    both({ index: 1, place: { groupId: 'g1', section: 'group' } })
  );
  expect(at(group, 1)).toEqual(
    both({ index: 1, place: { partId: 'p2', section: 'part' } })
  );
  expect(at(fixture('canvas-shared-stem'), 1)).toEqual(
    both({ index: 1, place: { section: 'stem' } })
  );
  const emptied: Question = {
    ...group,
    groups: [{ blocks: [], id: 'g1' }],
    stem: [...group.stem, { type: 'canvas' }],
  };
  expect(at(emptied, 0)).toEqual(
    both({ index: 1, place: { section: 'stem' } })
  );
  expect(at(fixture('canvas-shared-none-above-rejected'), 0)).toEqual(
    both(null)
  );
  expect(at(fixture('canvas-shown'), 0)).toEqual(both(null));
});

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

it('moves a text block with its blanks and their answers, renumbering them', () => {
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
  const [boils, freezes] = gapListsByBlock(part);
  const next = withGapsBlocks(
    part,
    [part.blocks[1], part.blocks[0]],
    [freezes, boils]
  );
  expect(next.blocks).toEqual([
    { text: 'Freezes at (1) ______.', type: 'text' },
    { text: 'Boils at (2) ______.', type: 'text' },
  ]);
  expect(next.answer).toMatchObject({ accepted: [['0'], ['100']] });
});
