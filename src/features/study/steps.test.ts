import { expect, it } from 'vitest';
import {
  answerStep,
  currentStep,
  nextStep,
  previousStep,
  startSteps,
} from './steps';

it('keeps a rated item read only on Previous and lets a skipped one be answered', () => {
  let s = startSteps<number>(['a', 'b', 'c']);
  s = answerStep(s, 3); // a rated
  s = nextStep(s); // b skipped, sent to the end
  expect(s.queue).toEqual(['c', 'b']);

  s = previousStep(s);
  expect(currentStep(s)).toEqual({ key: 'b', past: true, record: undefined });
  s = previousStep(s);
  expect(currentStep(s)).toEqual({ key: 'a', past: true, record: 3 });
  expect(answerStep(s, 1)).toBe(s); // no second record

  s = nextStep(s); // forward to the skipped b
  s = answerStep(s, 2);
  expect(s.queue).toEqual(['c']);
  expect(currentStep(s)).toEqual({ key: 'c', past: false, record: undefined });
});

it('skips an item to the end once in a session, then leaves it behind', () => {
  let s = startSteps<number>(['a', 'b']);
  s = nextStep(s, { skipOnce: true });
  s = nextStep(s, { skipOnce: true });
  expect(s.queue).toEqual(['a', 'b']);
  s = nextStep(s, { skipOnce: true });
  s = nextStep(s, { skipOnce: true });
  expect(currentStep(s)).toBeNull();
});

it('resumes after the answered items, which Previous reaches', () => {
  let s = startSteps<number>(['b'], [{ key: 'a', record: 4 }]);
  expect(currentStep(s)?.key).toBe('b');
  s = previousStep(s);
  expect(currentStep(s)).toEqual({ key: 'a', past: true, record: 4 });
});

it('requeues a live item when asked (Again in flashcard study)', () => {
  const s = answerStep(startSteps<number>(['a', 'b']), 1, { requeue: true });
  expect(s.queue).toEqual(['b', 'a']);
});

it('stays on a checked item until Next', () => {
  let s = answerStep(startSteps<number>(['a', 'b']), 3, { stay: true });
  expect(currentStep(s)).toEqual({ key: 'a', past: true, record: 3 });
  s = nextStep(s);
  expect(currentStep(s)?.key).toBe('b');
});
