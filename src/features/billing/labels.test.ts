import { expect, it } from 'vitest';
import { areaOf } from './labels';

// Epo 2026-11-13: grading and paper marking count with quiz writing.
it('puts quiz grading under quiz creation', () => {
  expect(areaOf('quiz').key).toBe('generate');
  expect(areaOf('generate').key).toBe('generate');
  expect(areaOf('system').key).toBe('other');
});
