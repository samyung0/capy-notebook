import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReviewItem } from '@/api/types';
import { PREF_KEYS } from '@/lib/localPrefs';
import { currentBatch } from './quickActions';

const card = (itemId: string): ReviewItem => ({
  front: itemId,
  itemId,
  kind: 'card',
  materialId: 'set',
  materialTitle: 'Cards',
});

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps a batch with its answered items for four hours, then starts anew', () => {
  const first = currentBatch('ws', [card('a'), card('b')]);
  localStorage.setItem(
    PREF_KEYS.quickReview('ws'),
    JSON.stringify({ ...first, done: ['set/a'] })
  );
  vi.advanceTimersByTime(3 * 60 * 60 * 1000);
  expect(currentBatch('ws', [card('c')])).toMatchObject({
    done: ['set/a'],
    items: [{ itemId: 'a' }, { itemId: 'b' }],
  });
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(currentBatch('ws', [card('c')])).toMatchObject({
    done: [],
    items: [{ itemId: 'c' }],
  });
});
