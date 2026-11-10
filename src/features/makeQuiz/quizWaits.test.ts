import { expect, it, vi } from 'vitest';
import { quizWaitStatus, waitingFileState } from './quizWaits';

vi.mock('@/api/hooks', () => ({ filesQuery: vi.fn() }));

const file = (status: 'failed' | 'processing' | 'ready', indexed: boolean) => [
  { id: 'f', indexed, status },
];

it('follows a chosen file from its upload to its text', () => {
  const row = {};
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

it('keeps a file by its id once its upload row has gone, as after a reload', () => {
  expect(
    waitingFileState({ fileId: 'f' }, undefined, file('ready', true))
  ).toBe('read');
  expect(waitingFileState({}, undefined, [])).toBe('gone');
});

// Epo 2026-11-09: a failed file no longer ends the wait; the quiz goes on with the
// files read, and only every file failing fails it.
it('waits for every file, then goes on with those read', () => {
  expect(quizWaitStatus(['read', 'reading'])).toBe('reading');
  expect(quizWaitStatus(['reading', 'failed'])).toBe('reading');
  expect(quizWaitStatus(['read', 'read'])).toBe('ready');
  expect(quizWaitStatus(['read', 'gone'])).toBe('ready');
  expect(quizWaitStatus(['failed', 'gone'])).toBe('failed');
});
