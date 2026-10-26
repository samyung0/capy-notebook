import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimRecentOpens,
  pruneRecentOpens,
  RECENT_OPENS_MAX,
  readRecentOpens,
  recordRecentOpen,
} from './recentOpens';

describe('recordRecentOpen', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('moves a reopened item to the front', () => {
    recordRecentOpen('file', 'f_1');
    recordRecentOpen('material', 'm_1');
    recordRecentOpen('file', 'f_1');
    expect(readRecentOpens().map((open) => [open.kind, open.id])).toEqual([
      ['file', 'f_1'],
      ['material', 'm_1'],
    ]);
  });

  it('keeps the newest opens only', () => {
    for (let i = 0; i <= RECENT_OPENS_MAX; i++)
      recordRecentOpen('file', `f_${i}`);
    const opens = readRecentOpens();
    expect(opens).toHaveLength(RECENT_OPENS_MAX);
    expect(opens[0].id).toBe(`f_${RECENT_OPENS_MAX}`);
  });

  it('keeps an account its own opens and drops another account’s', () => {
    claimRecentOpens('u_a');
    recordRecentOpen('file', 'f_a');
    claimRecentOpens('u_a');
    expect(readRecentOpens().map((open) => open.id)).toEqual(['f_a']);
    claimRecentOpens('u_b');
    expect(readRecentOpens()).toEqual([]);
  });

  it('drops opens a list was asked for and left out', () => {
    recordRecentOpen('material', 'm_1');
    recordRecentOpen('file', 'f_gone');
    recordRecentOpen('file', 'f_kept');
    pruneRecentOpens('file', ['f_gone', 'f_kept'], ['f_kept']);
    expect(readRecentOpens().map((open) => open.id)).toEqual(['f_kept', 'm_1']);
  });
});
