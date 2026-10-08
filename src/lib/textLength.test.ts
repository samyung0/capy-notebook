import { expect, it } from 'vitest';
import { textLength } from './textLength';

it('counts Unicode code points like the backend', () => {
  expect(textLength('a 光\n😀')).toBe(5);
  expect(textLength('😀'.repeat(5000))).toBe(5000);
  expect(textLength(undefined)).toBe(0);
});
