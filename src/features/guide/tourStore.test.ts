import { afterEach, expect, it, vi } from 'vitest';
import { PREF_KEYS } from '@/lib/localPrefs';
import { registerTourPanels, startTour, stopTour } from './tourStore';

afterEach(() => vi.unstubAllGlobals());

it('puts the workspace panels back as they were before the tour', () => {
  const values = new Map<string, string>([[PREF_KEYS.leftView, '"files"']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const restore = vi.fn();
  const unregister = registerTourPanels({
    current: { restore, showChats: vi.fn(), showFiles: vi.fn() },
  });

  startTour('ws_1');
  // The Files and Chats steps open both panels on their views.
  values.set(PREF_KEYS.rightPanel, 'true');
  values.set(PREF_KEYS.rightView, '"files"');
  values.set(PREF_KEYS.leftView, '"chats"');
  stopTour();

  // The right panel was never opened: it stays hidden by default.
  expect(values.has(PREF_KEYS.rightPanel)).toBe(false);
  expect(values.has(PREF_KEYS.rightView)).toBe(false);
  expect(values.get(PREF_KEYS.leftView)).toBe('"files"');
  expect(restore).toHaveBeenCalledOnce();
  unregister();
});
