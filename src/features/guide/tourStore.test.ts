import { afterEach, expect, it, vi } from 'vitest';
import { PREF_KEYS } from '@/lib/localPrefs';
import { registerTourPanels, startTour, stopTour } from './tourStore';

afterEach(() => vi.unstubAllGlobals());

it('puts the workspace panels back as they were before the tour', () => {
  const values = new Map<string, string>([[PREF_KEYS.rightView, '"chat"']]);
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
  // The Files step opens the right panel on Files.
  values.set(PREF_KEYS.rightPanel, 'true');
  values.set(PREF_KEYS.rightView, '"files"');
  stopTour();

  // The right panel was never opened: it stays hidden by default, on its view.
  expect(values.has(PREF_KEYS.rightPanel)).toBe(false);
  expect(values.get(PREF_KEYS.rightView)).toBe('"chat"');
  expect(restore).toHaveBeenCalledOnce();
  unregister();
});
