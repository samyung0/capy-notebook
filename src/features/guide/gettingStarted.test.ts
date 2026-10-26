import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREF_KEYS } from '@/lib/localPrefs';
import {
  hideGettingStarted,
  markGettingStarted,
  startGettingStarted,
} from './gettingStarted';

describe('gettingStarted', () => {
  const values = new Map<string, string>();
  const stored = () =>
    JSON.parse(values.get(PREF_KEYS.gettingStarted) ?? 'null');

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('records steps done in the browser that onboarded', () => {
    startGettingStarted('u_1');
    markGettingStarted('chat');
    markGettingStarted('upload');
    expect(stored()).toEqual({
      done: ['chat', 'upload'],
      hidden: false,
      owner: 'u_1',
    });
  });

  it('keeps the list when the same account starts again', () => {
    startGettingStarted('u_1');
    markGettingStarted('plan');
    startGettingStarted('u_1');
    expect(stored().done).toEqual(['plan']);
  });

  it('closes the list', () => {
    startGettingStarted('u_1');
    hideGettingStarted();
    expect(stored().hidden).toBe(true);
  });
});
