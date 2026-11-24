import { beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { DeletedItem } from '@/api/client';

const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));
const { m } = await import('@/i18n');

const QUIZ: DeletedItem = { kind: 'quiz', name: 'Cells' };

// A fresh module each time: the writer handed in is module state.
beforeEach(() => {
  vi.resetModules();
  userToast.mockClear();
});

it('saves through the writer the app’s entry handed in', async () => {
  const { downloadRecovery, provideRecoveryWriter } = await import(
    './recoveryDownload'
  );
  const save = vi.fn(async () => undefined);
  provideRecoveryWriter(async () => save);
  const content = new Y.Doc();
  const keys = new Y.Doc();

  await downloadRecovery(QUIZ, content, keys);

  expect(save).toHaveBeenCalledWith(QUIZ, content, keys);
  expect(userToast).not.toHaveBeenCalled();
});

it('says the file could not be made when no writer was handed in', async () => {
  const { downloadRecovery } = await import('./recoveryDownload');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await downloadRecovery(QUIZ, new Y.Doc());

  expect(userToast).toHaveBeenCalledWith({
    title: m.lost_edits_download_failed(),
    variant: 'error',
  });
});
