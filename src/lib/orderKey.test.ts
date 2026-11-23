import { expect, it } from 'vitest';
import { keyBetween, risingOrders } from './orderKey';

// The same vectors as collaboration-rs/crates/notes/src/order.rs: the server
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

/** `risingOrders` of `[id, held key]` pairs. */
const rise = (held: [string, string][]) =>
  risingOrders(held.map(([id, order]) => ({ id, order })));

// The same vectors as `rising` in collaboration-rs/crates/notes/src/order.rs.
it('keeps every held key that still rises: new entries after them re-key none', () => {
  expect(
    rise([
      ['p0', 'a0'],
      ['p1', 'a5'],
      ['p2', ''],
    ])
  ).toEqual(['a0', 'a5', 'a6']);
  expect(
    rise([
      ['p0', 'a0'],
      ['p1', ''],
      ['p2', 'a5'],
    ])
  ).toEqual(['a0', 'a1', 'a5']);
});

it('gives a moved entry alone a key between its neighbours', () => {
  expect(
    rise([
      ['p0', 'a2'],
      ['p1', 'a0'],
      ['p2', 'a1'],
    ])
  ).toEqual(['Zz', 'a0', 'a1']);
  expect(
    rise([
      ['p0', 'a1'],
      ['p1', 'a2'],
      ['p2', 'a0'],
    ])
  ).toEqual(['a1', 'a2', 'a3']);
});

it('compares tied keys by id, as readers sort', () => {
  // A tie two adds left, wanted in id order, stays.
  expect(
    rise([
      ['b', 'a0'],
      ['c', 'a0'],
      ['d', 'a1'],
    ])
  ).toEqual(['a0', 'a0', 'a1']);
  // Wanted against id order, one of the two takes a new key.
  expect(
    rise([
      ['c', 'a0'],
      ['b', 'a0'],
      ['d', 'a1'],
    ])
  ).toEqual(['Zz', 'a0', 'a1']);
});

it('re-keys the later tied neighbours with an entry placed between them', () => {
  expect(
    rise([
      ['b', 'a0'],
      ['x', ''],
      ['c', 'a0'],
      ['d', 'a1'],
    ])
  ).toEqual(['a0', 'a0V', 'a0l', 'a1']);
  expect(
    rise([
      ['b', 'a0'],
      ['x', ''],
      ['c', 'a0'],
    ])
  ).toEqual(['a0', 'a1', 'a2']);
  // A held entry moved between them.
  expect(
    rise([
      ['b', 'a0'],
      ['m', 'a5'],
      ['c', 'a0'],
      ['d', 'a1'],
    ])
  ).toEqual(['a0', 'a0V', 'a0l', 'a1']);
  // A three-way tie, an entry put after the first.
  expect(
    rise([
      ['b', 'a0'],
      ['x', ''],
      ['c', 'a0'],
      ['d', 'a0'],
    ])
  ).toEqual(['a0', 'a1', 'a2', 'a3']);
});

it('keeps a tie with an entry added before or after it', () => {
  expect(
    rise([
      ['n', ''],
      ['b', 'a0'],
      ['c', 'a0'],
    ])
  ).toEqual(['Zz', 'a0', 'a0']);
  expect(
    rise([
      ['b', 'a3'],
      ['c', 'a3'],
      ['n', ''],
    ])
  ).toEqual(['a3', 'a3', 'a4']);
});

it('keeps a bystander key inside a gap that splits a tie', () => {
  // c moved after d: d keeps its key, c alone takes a new one.
  expect(
    rise([
      ['b', 'a1'],
      ['d', 'a3'],
      ['c', 'a1'],
    ])
  ).toEqual(['a1', 'a3', 'a4']);
});
