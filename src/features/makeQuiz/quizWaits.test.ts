import { expect, it, vi } from 'vitest';
import { waitingFileState } from './quizWaits';

vi.mock('@/api/hooks', () => ({ filesQuery: vi.fn() }));

const file = (status: 'failed' | 'processing' | 'ready', indexed: boolean) => [
  { id: 'f', indexed, status },
];

it('follows a chosen file from its upload to its text', () => {
  const row = { key: 'k' };
  const uploading = { stage: 'uploading' as const };
  const sent = { fileId: 'f', stage: 'added' as const };
  expect(waitingFileState(row, uploading, [])).toBe('reading');
  expect(waitingFileState(row, { stage: 'failed' }, [])).toBe('failed');
  expect(waitingFileState(row, sent, undefined)).toBe('reading');
  expect(waitingFileState(row, sent, file('processing', false))).toBe(
    'reading'
  );
  expect(waitingFileState(row, sent, file('ready', true))).toBe('read');
  expect(waitingFileState(row, sent, file('failed', false))).toBe('failed');
});

it('keeps a file by its id once its upload row has gone, and drops one removed', () => {
  expect(
    waitingFileState({ fileId: 'f', key: 'k' }, undefined, file('ready', true))
  ).toBe('read');
  expect(waitingFileState({ key: 'k' }, undefined, [])).toBe('gone');
});
