import { expect, it } from 'vitest';
import { cloneHref, parseCloneTarget } from './cloneLink';

it('round-trips a clone link and rejects anything else', () => {
  const token = 'mat_1a2b.AAAAAAAAAAAAAAAA';
  const href = cloneHref('note', token);
  expect(href).toBe('/?clone=note%3Amat_1a2b.AAAAAAAAAAAAAAAA');
  expect(
    parseCloneTarget(new URLSearchParams(href.slice(2)).get('clone'))
  ).toEqual({ id: 'mat_1a2b', kind: 'note', token });
  for (const bad of [
    `file:${token}`,
    'note:',
    'note:mat_1a2b',
    `note:${token}:b`,
    'note:../x',
    42,
  ])
    expect(parseCloneTarget(bad)).toBeNull();
});
