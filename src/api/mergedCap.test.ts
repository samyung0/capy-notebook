import { expect, it } from 'vitest';
import { passesCap } from './mergedCap';

// An editor stops at the cap as the text reads when written (Epo 2026-11-22).
it('refuses an edit past the cap, and only a lengthening one past it', () => {
  expect(passesCap(10, 9, 10)).toBe(false);
  expect(passesCap(11, 10, 10)).toBe(true);
  // Two people's typing merged the text to 14: shortening or replacing goes.
  expect(passesCap(13, 14, 10)).toBe(false);
  expect(passesCap(14, 14, 10)).toBe(false);
  expect(passesCap(15, 14, 10)).toBe(true);
});
