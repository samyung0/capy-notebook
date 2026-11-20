import { expect, it } from 'vitest';
import { keyBetween, risingOrders } from './orderKey';

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

it('keeps every held key that still rises: new entries after them re-key none', () => {
  expect(risingOrders(['a0', 'a5', ''])).toEqual(['a0', 'a5', 'a6']);
  expect(risingOrders(['a0', '', 'a5'])).toEqual(['a0', 'a1', 'a5']);
});

it('gives a moved entry alone a key between its neighbours', () => {
  expect(risingOrders(['a2', 'a0', 'a1'])).toEqual(['Zz', 'a0', 'a1']);
  expect(risingOrders(['a1', 'a2', 'a0'])).toEqual(['a1', 'a2', 'a3']);
});
