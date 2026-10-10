import { expect, it } from 'vitest';
import { keyBetween } from './orderKey';

// The same vectors as collaboration-rs/crates/items/src/order.rs: the server
// writes and checks the keys this module writes.
it('writes the keys the collaboration server writes', () => {
  let key = keyBetween(null, null);
  expect(key).toBe('a0');
  for (let i = 0; i < 35; i++) key = keyBetween(key, null);
  expect(key).toBe('aZ');
  for (let i = 0; i < 26; i++) key = keyBetween(key, null);
  expect(key).toBe('az');
  expect(keyBetween('az', null)).toBe('b00');
  expect(keyBetween('a0', 'a1')).toBe('a0V');
  expect(keyBetween('a0V', 'a1')).toBe('a0l');
  expect(keyBetween(null, 'a0')).toBe('Zz');
  expect(keyBetween(null, 'a0V')).toBe('a0');
  expect(() => keyBetween('a1', 'a1')).toThrow();
});
