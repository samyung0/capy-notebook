import { expect, it } from 'vitest';
import {
  answerStep,
  currentStep,
  startSteps,
  withKeys,
} from '@/features/study/steps';
import { resumeSteps, studyIds } from './StudyBody';

const card = (id: string, front: string) => ({ back: '', front, id });

// REVIEW3 N6: an editor blanking a card while retyping it must not send it
// out of a learner's session and back at its end, where it could be rated a
// second time.
it('keeps a card in its place while an editor retypes it blank', () => {
  const cards = [
    card('c1', 'Cell'),
    card('c2', 'Golgi'),
    card('c3', 'Ribosome'),
  ];
  let ids = studyIds(cards);
  let s = startSteps<string>(ids);
  s = answerStep(s, 'good');
  const follow = (next: typeof cards) => {
    ids = studyIds(next, ids);
    s = withKeys(s, ids);
  };
  follow(cards.map((c) => (c.id === 'c1' ? card('c1', '') : c)));
  follow(cards.map((c) => (c.id === 'c1' ? card('c1', 'Nucleus') : c)));
  s = answerStep(s, 'good');
  s = answerStep(s, 'good');
  expect(currentStep(s)).toBeNull();
  // A blank card new to the session stays out; a removed one leaves.
  follow([...cards.slice(1), card('c4', '')]);
  expect(ids).toEqual(['c2', 'c3']);
});

// A reloaded run picks up where it was: unrated cards first in set order, then
// the ones last rated Again; a card deleted since leaves the run.
it('resumes a kept run', () => {
  const rated = (id: string, ratings: number[]) => ({
    ...card(id, id),
    ratings,
  });
  const { done, queue } = resumeSteps(
    ['c1', 'c2', 'c3', 'c4'],
    [rated('c2', [1]), rated('c1', [1, 3]), rated('gone', [3])]
  );
  expect(done).toEqual([
    { key: 'c2', record: 'again' },
    { key: 'c1', record: 'good' },
  ]);
  expect(queue).toEqual(['c3', 'c4', 'c2']);
});
