import { describe, expect, it, vi } from 'vitest';
import { collectSelectionPages, pickKeys } from './useFileSelection';

vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
vi.mock('@/i18n', () => ({ m: {} }));

describe('collectSelectionPages', () => {
  it('includes every page before selecting or confirming empty trash', async () => {
    const first = { items: ['file'], nextCursor: 'page-2' };
    const second = { items: ['note'], nextCursor: 'page-3' };
    const third = { items: ['quiz'] };
    const fetchNext = vi
      .fn()
      .mockResolvedValueOnce({ data: { pages: [first, second] } })
      .mockResolvedValueOnce({ data: { pages: [first, second, third] } });

    await expect(collectSelectionPages([first], fetchNext)).resolves.toEqual([
      'file',
      'note',
      'quiz',
    ]);
    expect(fetchNext).toHaveBeenCalledTimes(2);
  });

  it('does not fetch when the full list is already loaded', async () => {
    const fetchNext = vi.fn();
    await expect(
      collectSelectionPages([{ items: ['file'] }], fetchNext)
    ).resolves.toEqual(['file']);
    expect(fetchNext).not.toHaveBeenCalled();
  });

  it('rejects a failed page instead of returning a partial deletion target', async () => {
    const fetchNext = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(
      collectSelectionPages(
        [{ items: ['file'], nextCursor: 'next' }],
        fetchNext
      )
    ).rejects.toThrow('offline');
  });

  it('rejects unchanged pagination instead of looping', async () => {
    const pages = [{ items: ['file'], nextCursor: 'next' }];
    const fetchNext = vi.fn().mockResolvedValue({ data: { pages } });
    await expect(collectSelectionPages(pages, fetchNext)).rejects.toThrow(
      'Selection page unavailable'
    );
    expect(fetchNext).toHaveBeenCalledTimes(1);
  });
});

describe('pickKeys', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('selects only, adds or removes the clicked item', () => {
    expect(pickKeys(['a', 'b'], order, 'c', 'only', 'a')).toEqual(['c']);
    expect(pickKeys(['a'], order, 'c', 'toggle', 'a')).toEqual(['a', 'c']);
    expect(pickKeys(['a', 'c'], order, 'c', 'toggle', 'a')).toEqual(['a']);
  });

  it('adds the span from the anchor in either direction', () => {
    expect(pickKeys(['b'], order, 'd', 'range', 'b')).toEqual(['b', 'c', 'd']);
    expect(pickKeys(['e', 'a'], order, 'b', 'range', 'd')).toEqual([
      'e',
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('falls back to the clicked item without an anchor', () => {
    expect(pickKeys([], order, 'c', 'range', null)).toEqual(['c']);
  });
});
