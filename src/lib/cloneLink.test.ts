import { expect, it } from 'vitest';
import { cloneHref, parseCloneTarget } from './cloneLink';

it('round-trips a clone link and rejects anything else', () => {
  const href = cloneHref('note', 'mat_1a2b');
  expect(href).toBe('/?clone=note%3Amat_1a2b');
  expect(
    parseCloneTarget(new URLSearchParams(href.slice(2)).get('clone'))
  ).toEqual({ id: 'mat_1a2b', kind: 'note' });
  for (const bad of ['file:mat_1', 'note:', 'note:a:b', 'note:../x', 42])
    expect(parseCloneTarget(bad)).toBeNull();
});
