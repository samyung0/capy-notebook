import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimSentOpens,
  dropOpen,
  OPEN_WINDOW_MS,
  takeOpen,
} from './sentOpens';

describe('takeOpen', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
    claimSentOpens('u_1');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends once per target per window', () => {
    expect(takeOpen('workspace:ws_a', 0)).toBe(true);
    expect(takeOpen('workspace:ws_a', OPEN_WINDOW_MS - 1)).toBe(false);
    expect(takeOpen('file:ws_a', 1)).toBe(true);
    expect(takeOpen('workspace:ws_a', OPEN_WINDOW_MS)).toBe(true);
  });

  it('sends again at once after a drop', () => {
    takeOpen('material:m_1', 0);
    dropOpen('material:m_1');
    expect(takeOpen('material:m_1', 1)).toBe(true);
  });

  it('starts over for another account', () => {
    takeOpen('file:f_1', 0);
    claimSentOpens('u_2');
    expect(takeOpen('file:f_1', 1)).toBe(true);
  });
});
