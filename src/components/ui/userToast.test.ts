import { beforeEach, expect, it } from 'vitest';
import { dismissToast, finishToast, shownToast, userToast } from './userToast';

beforeEach(() => {
  dismissToast();
  const toast = shownToast();
  if (toast) finishToast(toast.id);
});

it('counts the same toast up instead of queueing it', () => {
  userToast({ title: 'Link copied' });
  const first = shownToast()!;
  userToast({ title: 'Link copied' });
  userToast({ title: 'Link copied' });
  expect(shownToast()).toMatchObject({ count: 3, id: first.id });
  expect(shownToast()!.revision).toBeGreaterThan(first.revision);
});

it('shows a different toast once the shown one has closed', () => {
  userToast({ title: 'Could not save', variant: 'error' });
  userToast({ title: 'Saved', variant: 'success' });
  expect(shownToast()?.title).toBe('Could not save');
  dismissToast(shownToast()!.id);
  expect(shownToast()?.closing).toBe(true);
  finishToast(shownToast()!.id);
  expect(shownToast()).toMatchObject({ count: 1, title: 'Saved' });
});

it('turns a working toast into its done toast in place', () => {
  userToast({ id: 'mark', title: 'Marking 12 answers…', variant: 'loading' });
  userToast({ id: 'mark', title: 'Marked 12 answers', variant: 'success' });
  expect(shownToast()).toMatchObject({
    count: 1,
    id: 'mark',
    title: 'Marked 12 answers',
    variant: 'success',
  });
});
