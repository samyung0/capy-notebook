import { beforeEach, expect, it, vi } from 'vitest';
import { savedForAccount } from './savedForAccount';

const isState = (value: unknown): value is { items: string[] } =>
  Array.isArray((value as { items?: unknown } | null)?.items);

beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
  });
});

const open = () => savedForAccount('k', { items: [] as string[] }, isState);

it('finds what was saved after a reload', () => {
  open().store.setState({ items: ['a'] });
  expect(open().store.getState().items).toEqual(['a']);
});

it('keeps it for its account and drops it for another', () => {
  const first = open();
  first.claim('user_1');
  first.store.setState({ items: ['a'] });

  const reloaded = open();
  reloaded.claim('user_1');
  expect(reloaded.store.getState().items).toEqual(['a']);

  reloaded.claim('user_2');
  expect(reloaded.store.getState().items).toEqual([]);
  expect(open().store.getState().items).toEqual([]);
});
