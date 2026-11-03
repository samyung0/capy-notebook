import { beforeEach, expect, it } from 'vitest';
import { dismissToast, finishToast, shownToasts, userToast } from './userToast';

beforeEach(() => {
  dismissToast();
  const { error, other } = shownToasts();
  if (error) finishToast(error.id);
  if (other) finishToast(other.id);
});

it('counts the same toast up instead of queueing it', () => {
  userToast({ title: 'Link copied' });
  const first = shownToasts().other!;
  userToast({ title: 'Link copied' });
  userToast({ title: 'Link copied' });
  expect(shownToasts().other).toMatchObject({ count: 3, id: first.id });
  expect(shownToasts().other!.revision).toBeGreaterThan(first.revision);
});

it('shows a different toast once the shown one has closed', () => {
  userToast({ title: 'Settings saved', variant: 'success' });
  userToast({ title: 'Link copied' });
  expect(shownToasts().other?.title).toBe('Settings saved');
  dismissToast(shownToasts().other!.id);
  expect(shownToasts().other?.closing).toBe(true);
  finishToast(shownToasts().other!.id);
  expect(shownToasts().other).toMatchObject({ count: 1, title: 'Link copied' });
});

it('keeps an open error at the bottom while other toasts show above it', () => {
  userToast({ title: 'Could not save', variant: 'error' });
  userToast({ title: 'Saved', variant: 'success' });
  userToast({ title: 'Could not save', variant: 'error' });
  expect(shownToasts()).toMatchObject({
    error: { count: 2, title: 'Could not save' },
    other: { title: 'Saved' },
  });
});

it('turns a working toast into its done toast in place', () => {
  userToast({ id: 'mark', title: 'Marking 12 answers…', variant: 'loading' });
  userToast({ id: 'mark', title: 'Marked 12 answers', variant: 'success' });
  expect(shownToasts().other).toMatchObject({
    count: 1,
    id: 'mark',
    title: 'Marked 12 answers',
    variant: 'success',
  });
});
