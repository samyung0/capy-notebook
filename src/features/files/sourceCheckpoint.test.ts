import { expect, it } from 'vitest';
import { acknowledgeSourceCheckpoint } from './useSourceSession';

it('keeps later authored changes dirty when an earlier or unrelated checkpoint is acknowledged', () => {
  const state = {
    acknowledged: -1,
    pending: new Map([
      ['first', 1],
      ['second', 2],
    ]),
    sequence: 2,
  };
  expect(acknowledgeSourceCheckpoint(state, ['unrelated'])).toBe(false);
  expect(acknowledgeSourceCheckpoint(state, ['first'])).toBe(false);
  expect(state.acknowledged).toBe(1);
  expect(acknowledgeSourceCheckpoint(state, ['second'])).toBe(true);
  expect(acknowledgeSourceCheckpoint(state, ['unrelated'])).toBe(false);
  expect(acknowledgeSourceCheckpoint(state, ['second'])).toBe(false);
  state.sequence++;
  expect(acknowledgeSourceCheckpoint(state, ['second'])).toBe(false);
});
